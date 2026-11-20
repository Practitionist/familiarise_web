/**
 * "Notify me" on a sold-out webinar or class: notify-only, nothing is reserved.
 * A release path stages the notice inside its own transaction
 * (`stageSeatOpenedNotices`) and finishes it after the commit
 * (`finishSeatOpenedNotices`); every waiter hears at once and the first to pay
 * gets the seat. Rows are ordered by `createdAt`, so an ordered offer wave is a
 * `take` on the same compare-and-set.
 */

import {
  BackupInterestStatus,
  Prisma,
  type CollaboratorStatus,
  type ConsultantVerificationStatus,
  type OccurrenceCompletionStatus,
  type OrgPlanVisibility,
} from "@prisma/client";

import prisma, { type PrismaLike, type Tx } from "@/lib/prisma";
import { withSerializableRetry } from "@/lib/db/serializable-retry";
import { canViewPlanDetail } from "@/lib/data/plan-viewable";
import { publicProfileFacts } from "@/lib/profiles/public-profile";
import { MARKETPLACE_VISIBILITY } from "@/lib/api/plans/visibility";
import {
  MAX_GROUP_SESSION_PARTICIPANTS,
  getClassCapacity,
  getWebinarCapacity,
} from "@/lib/events/capacity";
import { classEnrolmentFrom } from "@/lib/booking/class-enrolment";
import { liveParticipant, paidParticipant } from "@/lib/booking/participants";
import { assertNotSelfBooking } from "@/lib/booking/self-booking";
import {
  canBuySeat,
  findPriorSeatPayments,
  seatRebuyRefusal,
  assertSeatRemintable,
  alreadyHeldSeatError,
} from "@/lib/payments/checkout/seats";
import { seatHoldingParticipant } from "@/utils/scheduling-engine/occupancyPolicy";
import type { StagedTrigger } from "@/lib/novu/outbox";
import { resolveRecipientBellPolicy } from "@/lib/novu/policy";
import { stageScopedPages } from "@/lib/novu/scoped-pages";
import { NOVU_WORKFLOWS } from "@/lib/novu/workflows";
import { flushNotificationsAfter } from "@/lib/novu/stage-then-attempt";
import {
  EVENT_SEAT_OPENED_EMAIL_TYPE,
  stageEventSeatOpenedEmails,
  type EventSeatOpenedEmailArgs,
} from "@/lib/email/senders/booking";
import { BookingRuleError } from "./booking-rule-error";
import {
  INTEREST_RENOTIFY_COOLDOWN_MS,
  OPEN_INTEREST,
  notifiableInterest,
  purgeSettledEventWaitlist,
  purgeableEventWaitlistWhere,
  renoticeBucket,
} from "./interest/lifecycle";

/** Open rows one learner may hold across events. */
export const EVENT_WAITLIST_USER_CAP = 5;
export const EVENT_SEAT_OPENED_CLAIM_SCOPE = "event-waitlist.seat-opened";

export type EventWaitlistKind = "WEBINAR" | "CLASS";

const DEAD_SESSION: OccurrenceCompletionStatus[] = ["CANCELLED", "RESCHEDULED"];
const HOST_COLLABORATOR: CollaboratorStatus[] = ["PENDING", "ACCEPTED"];

const PLAN_SELECT = {
  id: true,
  title: true,
  consultantProfileId: true,
  organizationId: true,
  visibility: true,
  archivedAt: true,
  maxParticipants: true,
  waitlistEnabled: true,
  waitlistMax: true,
  consultantProfile: { select: { userId: true, ...publicProfileFacts } },
  collaborators: {
    where: { status: { in: HOST_COLLABORATOR } },
    select: { consultantProfileId: true },
  },
} satisfies Prisma.WebinarPlanSelect;

const CLASS_PLAN_SELECT = {
  ...PLAN_SELECT,
  price: true,
  totalSessions: true,
  lateJoinUntilSession: true,
} satisfies Prisma.ClassPlanSelect;

function rosterSelect(now: Date) {
  return {
    id: true,
    organizationId: true,
    deletedAt: true,
    occurrences: {
      where: { deletedAt: null },
      select: {
        startsAt: true,
        completionStatus: true,
        ordinal: true,
        deletedAt: true,
      },
    },
    participants: {
      where: seatHoldingParticipant(now),
      select: { userId: true },
    },
  } satisfies Prisma.AppointmentSelect;
}

interface Roster {
  id: string;
  organizationId: string | null;
  deletedAt: Date | null;
  occurrences: {
    startsAt: Date;
    completionStatus: OccurrenceCompletionStatus;
    ordinal: number;
    deletedAt: Date | null;
  }[];
  participants: { userId: string }[];
}

interface EventPlan {
  id: string;
  title: string;
  consultantProfileId: string | null;
  organizationId: string | null;
  visibility: OrgPlanVisibility;
  archivedAt: Date | null;
  maxParticipants: number;
  waitlistEnabled: boolean;
  waitlistMax: number | null;
  consultantProfile: {
    userId: string;
    verificationStatus: ConsultantVerificationStatus;
    deletedAt: Date | null;
  } | null;
  collaborators: { consultantProfileId: string }[];
}

interface ClassEventPlan extends EventPlan {
  price: number | bigint;
  totalSessions: number;
  lateJoinUntilSession: number | null;
}

interface EventView {
  kind: EventWaitlistKind;
  eventId: string;
  status: string;
  deleted: boolean;
  instanceMax: number | null;
  plan: EventPlan | ClassEventPlan;
  appointment: Roster | null;
}

function webinarView(
  row: {
    id: string;
    status: string;
    deletedAt: Date | null;
    maxParticipants: number | null;
    webinarPlan: EventPlan;
  },
  appointment: Roster | null,
): EventView {
  return {
    kind: "WEBINAR",
    eventId: row.id,
    status: row.status,
    deleted: row.deletedAt !== null,
    instanceMax: row.maxParticipants,
    plan: row.webinarPlan,
    appointment,
  };
}

function classView(
  row: {
    id: string;
    status: string;
    deletedAt: Date | null;
    maxParticipants: number | null;
    classPlan: ClassEventPlan;
  },
  appointment: Roster | null,
): EventView {
  return {
    kind: "CLASS",
    eventId: row.id,
    status: row.status,
    deleted: row.deletedAt !== null,
    instanceMax: row.maxParticipants,
    plan: row.classPlan,
    appointment,
  };
}

const EVENT_FIELDS = {
  id: true,
  status: true,
  deletedAt: true,
  maxParticipants: true,
} as const;

async function readEventById(
  db: Pick<Tx, "webinar" | "class">,
  kind: EventWaitlistKind,
  eventId: string,
  now: Date,
): Promise<EventView | null> {
  if (kind === "WEBINAR") {
    const row = await db.webinar.findUnique({
      where: { id: eventId },
      select: {
        ...EVENT_FIELDS,
        webinarPlan: { select: PLAN_SELECT },
        appointment: { select: rosterSelect(now) },
      },
    });
    return row ? webinarView(row, row.appointment) : null;
  }
  const row = await db.class.findUnique({
    where: { id: eventId },
    select: {
      ...EVENT_FIELDS,
      classPlan: { select: CLASS_PLAN_SELECT },
      appointment: { select: rosterSelect(now) },
    },
  });
  return row ? classView(row, row.appointment) : null;
}

function appointmentEventSelect(now: Date) {
  return {
    ...rosterSelect(now),
    webinar: {
      select: { ...EVENT_FIELDS, webinarPlan: { select: PLAN_SELECT } },
    },
    class: {
      select: { ...EVENT_FIELDS, classPlan: { select: CLASS_PLAN_SELECT } },
    },
  } satisfies Prisma.AppointmentSelect;
}

function viewOfAppointment(
  row: Roster & {
    webinar: Parameters<typeof webinarView>[0] | null;
    class: Parameters<typeof classView>[0] | null;
  },
): EventView | null {
  const { webinar, class: cls, ...roster } = row;
  if (webinar) return webinarView(webinar, roster);
  if (cls) return classView(cls, roster);
  return null;
}

async function readEventByAppointment(
  tx: Pick<Tx, "appointment">,
  appointmentId: string,
  now: Date,
): Promise<EventView | null> {
  const row = await tx.appointment.findUnique({
    where: { id: appointmentId },
    // Runs inside every seat release: one joined statement, not eleven.
    relationLoadStrategy: "join",
    select: appointmentEventSelect(now),
  });
  return row ? viewOfAppointment(row) : null;
}

/** The next live session after `now`, if any. */
function nextStart(view: EventView, now: Date): Date | null {
  const starts = (view.appointment?.occurrences ?? [])
    .filter((o) => !DEAD_SESSION.includes(o.completionStatus))
    .map((o) => o.startsAt)
    .filter((startsAt) => startsAt > now)
    .sort((a, b) => a.getTime() - b.getTime());
  return starts[0] ?? null;
}

function classEnrolmentOpen(view: EventView, now: Date): boolean {
  if (view.kind !== "CLASS" || !("totalSessions" in view.plan)) return true;
  return (
    classEnrolmentFrom({
      pricePaise: view.plan.price,
      N: view.plan.totalSessions,
      lateJoinUntilSession: view.plan.lateJoinUntilSession,
      sessions: view.appointment?.occurrences ?? [],
      now,
    }).state === "open"
  );
}

function seatsRemaining(view: EventView): number {
  const hostUserId = view.plan.consultantProfile?.userId;
  const params = {
    plan: view.plan,
    excludeUserIds: hostUserId ? [hostUserId] : [],
  };
  const instance = {
    maxParticipants: view.instanceMax,
    appointment: { participants: view.appointment?.participants ?? [] },
  };
  return view.kind === "WEBINAR"
    ? getWebinarCapacity({ ...params, webinar: instance }).remaining
    : getClassCapacity({ ...params, classInstance: instance }).remaining;
}

const CLASS_SELLABLE = new Set(["SCHEDULED"]);

/** The event, its plan and its host are live; nothing about timing yet. */
function eventLive(view: EventView): boolean {
  return (
    !view.deleted &&
    !view.appointment?.deletedAt &&
    !view.plan.archivedAt &&
    !view.plan.consultantProfile?.deletedAt &&
    (view.kind === "WEBINAR"
      ? view.status === "SCHEDULED"
      : CLASS_SELLABLE.has(view.status))
  );
}

/** A seat can be bought now: a webinar is upcoming; a class has enrolment open by checkout's rule, late join included. */
function onSale(view: EventView, now: Date): boolean {
  if (!eventLive(view)) return false;
  return view.kind === "WEBINAR"
    ? nextStart(view, now) !== null
    : classEnrolmentOpen(view, now);
}

function listCap(plan: { waitlistMax: number | null }): number {
  return Math.min(
    plan.waitlistMax ?? MAX_GROUP_SESSION_PARTICIPANTS,
    MAX_GROUP_SESSION_PARTICIPANTS,
  );
}

export function eventCheckoutHref(
  kind: EventWaitlistKind,
  planId: string,
  eventId: string,
): string {
  const segment = kind === "CLASS" ? "class" : "webinar";
  return `/checkout/plans/${segment}/${planId}?eventId=${encodeURIComponent(eventId)}`;
}

const notFound = () =>
  new BookingRuleError(
    "EVENT_NOT_FOUND",
    "This session could not be found.",
    404,
  );

/** The join refusals that depend on the event's current state; returns what the insert needs. */
function assertJoinable(
  view: EventView,
  caller: { userId: string; viewerConsultantProfileId: string | null },
  now: Date,
): { appointmentId: string; plan: EventPlan } {
  if (
    view.kind === "CLASS" &&
    eventLive(view) &&
    !classEnrolmentOpen(view, now)
  ) {
    throw new BookingRuleError(
      "ENROLMENT_CLOSED",
      "Enrolment for this batch has closed. Please choose a batch that has not started yet.",
    );
  }
  if (!onSale(view, now)) {
    throw new BookingRuleError(
      "EVENT_CLOSED",
      "This session is no longer taking sign-ups.",
    );
  }
  assertNotSelfBooking(caller.viewerConsultantProfileId, {
    consultantProfileId: view.plan.consultantProfileId,
    collaboratorProfileIds: view.plan.collaborators.map(
      (c) => c.consultantProfileId,
    ),
  });
  if (!view.plan.waitlistEnabled) {
    throw new BookingRuleError(
      "WAITLIST_DISABLED",
      "The host is not taking a waitlist for this session.",
    );
  }
  const appointment = view.appointment;
  if (!appointment || seatsRemaining(view) > 0) {
    throw new BookingRuleError(
      "EVENT_NOT_FULL",
      "Seats are available — book now.",
    );
  }
  if (appointment.participants.some((p) => p.userId === caller.userId)) {
    throw alreadyHeldSeatError(view.kind);
  }
  return { appointmentId: appointment.id, plan: view.plan };
}

/**
 * Join the notify-me list of a sold-out event. Hidden and missing events both
 * answer EVENT_NOT_FOUND; an open row returns as it is.
 */
export async function joinEventWaitlist(args: {
  userId: string;
  /** The caller's own consultant profile, for the self-booking guard. */
  viewerConsultantProfileId: string | null;
  session: Parameters<typeof canViewPlanDetail>[1];
  kind: EventWaitlistKind;
  eventId: string;
  now?: Date;
}): Promise<{ status: BackupInterestStatus }> {
  const now = args.now ?? new Date();
  const view = await readEventById(prisma, args.kind, args.eventId, now);
  if (!view || !(await canViewPlanDetail(view.plan, args.session))) {
    throw notFound();
  }
  // A cheap refusal before the transaction; the transaction re-checks it all.
  assertJoinable(view, args, now);

  return withSerializableRetry(() =>
    prisma.$transaction(
      async (tx) => {
        // Availability and the list settings are re-read on every attempt: a
        // seat released after the read above must answer EVENT_NOT_FULL.
        const fresh = await readEventById(tx, args.kind, args.eventId, now);
        if (!fresh) throw notFound();
        const { appointmentId, plan } = assertJoinable(fresh, args, now);
        const prior = (
          await findPriorSeatPayments(tx, appointmentId, [args.userId])
        ).get(args.userId);
        if (prior && seatRebuyRefusal(prior) !== null) {
          assertSeatRemintable(prior, args.kind);
        }
        const key = {
          appointmentId_userId: { appointmentId, userId: args.userId },
        };
        const existing = await tx.appointmentWaitlist.findUnique({
          where: key,
          select: { status: true },
        });
        if (existing && OPEN_INTEREST.includes(existing.status))
          return existing;
        // One pg client per transaction: run its queries one after another.
        const onList = await tx.appointmentWaitlist.count({
          where: { appointmentId, status: { in: OPEN_INTEREST } },
        });
        const mine = await tx.appointmentWaitlist.count({
          where: { userId: args.userId, status: { in: OPEN_INTEREST } },
        });
        if (onList >= listCap(plan)) {
          throw new BookingRuleError(
            "WAITLIST_FULL",
            "The waitlist for this session is full.",
          );
        }
        if (mine >= EVENT_WAITLIST_USER_CAP) {
          throw new BookingRuleError(
            "EVENT_WAITLIST_CAP",
            `You can wait on at most ${EVENT_WAITLIST_USER_CAP} sessions at once — leave one to add another.`,
          );
        }
        return tx.appointmentWaitlist.upsert({
          where: key,
          create: {
            appointmentId,
            userId: args.userId,
            planKind: args.kind,
            planId: plan.id,
          },
          update: {
            status: BackupInterestStatus.WAITING,
            notifiedAt: null,
            bookedAt: null,
          },
          select: { status: true },
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
}

/** Leave the list; only the caller's own open row moves. */
export async function leaveEventWaitlist(
  userId: string,
  kind: EventWaitlistKind,
  eventId: string,
): Promise<number> {
  const { count } = await prisma.appointmentWaitlist.updateMany({
    where: {
      userId,
      status: { in: OPEN_INTEREST },
      appointment:
        kind === "WEBINAR" ? { webinarId: eventId } : { classId: eventId },
    },
    data: { status: BackupInterestStatus.EXPIRED },
  });
  return count;
}

export interface EventWaitlistAlertRow {
  kind: EventWaitlistKind;
  eventId: string;
  planId: string;
  planTitle: string;
  nextSessionAt: Date | null;
  status: BackupInterestStatus;
  notifiedAt: Date | null;
  checkoutHref: string;
  /** A seat can be bought right now: on sale by checkout's rule and at least one seat is free. */
  seatAvailable: boolean;
}

/** The caller's open rows, oldest first, for the learner's "My alerts" list. */
export async function listEventWaitlist(
  userId: string,
  now = new Date(),
): Promise<EventWaitlistAlertRow[]> {
  const rows = await prisma.appointmentWaitlist.findMany({
    where: { userId, status: { in: OPEN_INTEREST } },
    orderBy: { createdAt: "asc" },
    take: EVENT_WAITLIST_USER_CAP,
    select: {
      status: true,
      notifiedAt: true,
      appointment: { select: appointmentEventSelect(now) },
    },
  });
  return rows.flatMap((row) => {
    const view = viewOfAppointment(row.appointment);
    if (!view) return [];
    return [
      {
        kind: view.kind,
        eventId: view.eventId,
        planId: view.plan.id,
        planTitle: view.plan.title,
        nextSessionAt: nextStart(view, now),
        status: row.status,
        notifiedAt: row.notifiedAt,
        checkoutHref: eventCheckoutHref(view.kind, view.plan.id, view.eventId),
        seatAvailable: onSale(view, now) && seatsRemaining(view) > 0,
      },
    ];
  });
}

export interface StagedSeatOpened {
  pages: StagedTrigger[];
  email: EventSeatOpenedEmailArgs | null;
}

const NOTHING: StagedSeatOpened = { pages: [], email: null };

function notifiableWhere(
  appointmentId: string,
  now: Date,
): Prisma.AppointmentWaitlistWhereInput {
  return { appointmentId, ...notifiableInterest(now) };
}

/**
 * A seat on this event may have freed: inside the releasing transaction, flip
 * every eligible waiter to NOTIFIED in one compare-and-set and stage their
 * bells. The query count is the same for one waiter or two hundred. Pass a
 * `now` captured outside any retry so a retried transaction re-stages the
 * same keys.
 */
export async function stageSeatOpenedNotices(
  tx: Tx,
  appointmentId: string,
  now: Date,
): Promise<StagedSeatOpened> {
  const view = await readEventByAppointment(tx, appointmentId, now);
  if (
    !view ||
    !onSale(view, now) ||
    !view.plan.waitlistEnabled ||
    seatsRemaining(view) <= 0
  ) {
    return NOTHING;
  }
  const notifiable = notifiableWhere(appointmentId, now);
  let candidates = await tx.appointmentWaitlist.findMany({
    where: notifiable,
    orderBy: { createdAt: "asc" },
    take: MAX_GROUP_SESSION_PARTICIPANTS,
    select: { id: true, userId: true },
  });
  if (candidates.length === 0) return NOTHING;

  const plan = view.plan;
  const orgOnly = !MARKETPLACE_VISIBILITY.includes(plan.visibility);
  if (orgOnly) {
    const members = plan.organizationId
      ? await tx.membership.findMany({
          where: {
            organizationId: plan.organizationId,
            status: "ACTIVE",
            userId: { in: candidates.map((c) => c.userId) },
          },
          select: { userId: true },
        })
      : [];
    const memberIds = new Set(members.map((m) => m.userId));
    candidates = candidates.filter((c) => memberIds.has(c.userId));
    if (candidates.length === 0) return NOTHING;
  }

  const userIds = candidates.map((c) => c.userId);
  const priors = await findPriorSeatPayments(tx, appointmentId, userIds);
  const paidSeats = await tx.appointmentParticipant.findMany({
    where: {
      appointmentId,
      role: "CONSULTEE",
      userId: { in: userIds },
      ...paidParticipant(),
    },
    select: { userId: true },
  });
  const liveSeats = await tx.appointmentParticipant.findMany({
    where: {
      appointmentId,
      role: "CONSULTEE",
      userId: { in: userIds },
      ...liveParticipant(),
    },
    select: { userId: true },
  });
  const paid = new Set(paidSeats.map((s) => s.userId));
  const live = new Set(liveSeats.map((s) => s.userId));
  const seated = candidates.filter((c) => paid.has(c.userId));
  const eligible = candidates.filter(
    (c) =>
      !paid.has(c.userId) &&
      !live.has(c.userId) &&
      canBuySeat(priors.get(c.userId) ?? null),
  );

  // Backstop for a capture whose BOOKED hook did not run.
  if (seated.length > 0) {
    await tx.appointmentWaitlist.updateMany({
      where: {
        id: { in: seated.map((c) => c.id) },
        status: { in: OPEN_INTEREST },
      },
      data: { status: BackupInterestStatus.BOOKED, bookedAt: now },
    });
  }
  if (eligible.length === 0) return NOTHING;

  // The predicate in the WHERE skips a row a concurrent releaser just flipped.
  const notified = await tx.appointmentWaitlist.updateManyAndReturn({
    where: { ...notifiable, id: { in: eligible.map((c) => c.id) } },
    data: { status: BackupInterestStatus.NOTIFIED, notifiedAt: now },
    select: { userId: true },
  });
  if (notified.length === 0) return NOTHING;

  const recipients = notified.map((row) => row.userId);
  const bucket = renoticeBucket(now);
  const checkoutUrl = eventCheckoutHref(view.kind, plan.id, view.eventId);
  const workflowId = NOVU_WORKFLOWS.EVENT_SEAT_OPENED;
  const { allowedRecipients } = await resolveRecipientBellPolicy(
    workflowId,
    recipients,
    { tx },
  );
  // A waiter holds no seat yet: an org-only plan's bell is the org's, any other is personal.
  const scopeOrgId = orgOnly ? plan.organizationId : null;
  const pages = await stageScopedPages(tx, {
    workflowId,
    recipients: allowedRecipients.map((userId) => ({
      userId,
      organizationId: scopeOrgId,
    })),
    payload: {
      planTitle: plan.title,
      eventLabel: view.kind === "CLASS" ? "class" : "webinar",
      checkoutUrl,
    },
    dedupeKey: `seat-opened:${appointmentId}:${bucket}`,
    entityRef: `appointment:${appointmentId}`,
  });
  return {
    pages,
    email: {
      appointmentId,
      bucket,
      userIds: recipients,
      planTitle: plan.title,
      kind: view.kind,
      startsAt: nextStart(view, now),
      checkoutUrl,
    },
  };
}

/** After the commit only: attempt the bells, then render and stage the emails once per waiter and bucket. */
export async function finishSeatOpenedNotices(
  staged: StagedSeatOpened | null | undefined,
): Promise<void> {
  if (!staged) return;
  const op = "event-waitlist.seat-opened";
  await flushNotificationsAfter({ bells: staged.pages }, op);
  const email = staged.email;
  if (!email || email.userIds.length === 0) return;
  const rows = await stageEventSeatOpenedEmails(email, {
    scope: EVENT_SEAT_OPENED_CLAIM_SCOPE,
    key: (userId) => `${email.appointmentId}:${email.bucket}:${userId}`,
    ttlMs: 2 * INTEREST_RENOTIFY_COOLDOWN_MS,
  });
  await flushNotificationsAfter(
    { emails: [{ rows, emailType: EVENT_SEAT_OPENED_EMAIL_TYPE }] },
    op,
  );
}

/** The buyer's own open row on this appointment is BOOKED. */
export function markEventWaitlistBooked(
  tx: Pick<Tx, "appointmentWaitlist">,
  appointmentId: string,
  userId: string,
  now: Date,
) {
  return tx.appointmentWaitlist.updateMany({
    where: { appointmentId, userId, status: { in: OPEN_INTEREST } },
    data: { status: BackupInterestStatus.BOOKED, bookedAt: now },
  });
}

/** The host switched the waitlist off: open rows on the plan expire silently. */
export function expireEventWaitlistForPlan(
  tx: Pick<Tx, "appointmentWaitlist">,
  planKind: EventWaitlistKind,
  planId: string,
) {
  return tx.appointmentWaitlist.updateMany({
    where: { planKind, planId, status: { in: OPEN_INTEREST } },
    data: { status: BackupInterestStatus.EXPIRED },
  });
}

// Shared by the expiry write and the stale-request sweep's idle probe.
function lapsedEventWaitlistWhere(
  now: Date,
): Prisma.AppointmentWaitlistWhereInput {
  const ended = { in: ["COMPLETED" as const, "CANCELLED" as const] };
  return {
    status: { in: OPEN_INTEREST },
    appointment: {
      OR: [
        { deletedAt: { not: null } },
        { webinar: { is: { status: ended } } },
        { class: { is: { status: ended } } },
        {
          occurrences: {
            none: {
              deletedAt: null,
              completionStatus: { notIn: DEAD_SESSION },
              startsAt: { gt: now },
            },
          },
        },
      ],
    },
  };
}

export async function hasLapsedEventWaitlist(
  db: PrismaLike,
  now: Date,
): Promise<boolean> {
  const row = await db.appointmentWaitlist.findFirst({
    where: {
      OR: [lapsedEventWaitlistWhere(now), purgeableEventWaitlistWhere(now)],
    },
    select: { id: true },
  });
  return row !== null;
}

/** The stale-request arm: open rows on an ended event expire; settled rows past retention are deleted. */
export async function expireEventWaitlist(
  now: Date,
  purgeLimit: number,
): Promise<{ expired: number; purged: number }> {
  const expired = await prisma.appointmentWaitlist.updateMany({
    where: lapsedEventWaitlistWhere(now),
    data: { status: BackupInterestStatus.EXPIRED },
  });
  const purged = await purgeSettledEventWaitlist(prisma, now, purgeLimit);
  return { expired: expired.count, purged };
}
