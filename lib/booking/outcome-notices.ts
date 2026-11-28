/**
 * The session-outcome notices to both sides of a session, bell and email: the
 * proposal when the sweep writes a negative verdict, and the review when ops
 * change one. Read and rendered before the writing transaction, staged inside
 * it, and attempted after its commit (`flushNotificationsAfter`).
 */
import type { OccurrenceOutcome, Prisma } from "@prisma/client";

import prisma, { type Tx } from "@/lib/prisma";
import { goHref } from "@/lib/dashboard/go";
import { prepareSessionOutcomeNoticeEmails } from "@/lib/email/senders/booking";
import {
  stageScreenedEmails,
  type ScreenedRecipientEmails,
  type StagedRecipientEmail,
} from "@/lib/email/send-to-recipients";
import {
  formatNotificationDateTime,
  formatNotificationMoney,
} from "@/lib/novu/humanize";
import type { StagedTrigger } from "@/lib/novu/outbox";
import { bellRecipientZones } from "@/lib/novu/policy";
import { stagePreparedBells, type PreparedBell } from "@/lib/novu/service";
import {
  NOVU_WORKFLOWS,
  notificationScope,
  type SessionOutcomeProposedPayload,
  type SessionOutcomeReviewedPayload,
} from "@/lib/novu/workflows";
import {
  REFUNDABLE_BALANCE_SELECT,
  refundableBalancePaise,
} from "@/lib/payments/refundable-balance";
import { caseKeyOf } from "@/lib/support/case-key";
import { getAppUrl } from "@/lib/url";
import {
  OUTCOME_REPORT_WINDOW_HOURS,
  type NegativeMoneyOutcome,
} from "./misses";
import {
  proposedNoticeCopy,
  reviewedNoticeCopy,
  type NoticeBooking,
  type NoticeCopy,
  type NoticeSide,
  type RefundDestination,
  type SeatRefund,
} from "./outcome-notice-copy";
import { liveLearnerSeat } from "./participants";
import { occurrenceRefundKey } from "./class-sessions";
import {
  seatJoinedAt,
  seatSessionClaim,
  sessionRefundSpent,
} from "./seat-session";
import { SESSION_HOSTS_SELECT, sessionHostUserIds } from "./session-hosts";

const TITLED_PLAN = {
  title: true,
  recordingEnabled: true,
  consultantProfile: { select: { userId: true } },
} satisfies Prisma.ConsultationPlanSelect;

/** A payment's refundable balance and the funding legs its refund reverses. */
const SEAT_PAYMENT = {
  id: true,
  userId: true,
  createdAt: true,
  amount: true,
  currency: true,
  ...REFUNDABLE_BALANCE_SELECT,
  refunds: { select: { amountPaise: true, status: true, dedupeKey: true } },
  legs: { select: { source: true, amountPaise: true } },
} satisfies Prisma.PaymentSelect;

/** Who is on each side of the booking, what it is, and what each learner seat's refund would return, and where. */
const PARTIES_SELECT = {
  organizationId: true,
  consultation: { select: { consultationPlan: { select: TITLED_PLAN } } },
  subscription: { select: { subscriptionPlan: { select: TITLED_PLAN } } },
  trial: { select: { subscriptionPlan: { select: TITLED_PLAN } } },
  webinar: {
    select: {
      webinarPlan: {
        select: {
          ...TITLED_PLAN,
          collaborators:
            SESSION_HOSTS_SELECT.webinar.select.webinarPlan.select
              .collaborators,
        },
      },
    },
  },
  class: {
    select: {
      classPlan: {
        select: {
          ...TITLED_PLAN,
          collaborators:
            SESSION_HOSTS_SELECT.class.select.classPlan.select.collaborators,
        },
      },
    },
  },
  participants: {
    where: liveLearnerSeat(),
    select: { userId: true, status: true, createdAt: true, paymentId: true },
  },
  payment: {
    where: { paymentStatus: "SUCCEEDED", deletedAt: null },
    select: SEAT_PAYMENT,
  },
} satisfies Prisma.AppointmentSelect;

const readPartiesRow = (appointmentId: string) =>
  prisma.appointment.findUnique({
    where: { id: appointmentId },
    select: PARTIES_SELECT,
  });

/** The row as the client returns it: money columns are numbers at this boundary. */
export type OutcomePartiesRow = NonNullable<
  Awaited<ReturnType<typeof readPartiesRow>>
>;

function bookingOf(row: OutcomePartiesRow) {
  const shapes: [
    NoticeBooking,
    { title: string; recordingEnabled: boolean } | undefined,
  ][] = [
    ["class", row.class?.classPlan],
    ["webinar", row.webinar?.webinarPlan],
    ["consultation", row.consultation?.consultationPlan],
    ["subscription", row.subscription?.subscriptionPlan],
    ["trial", row.trial?.subscriptionPlan],
  ];
  const found = shapes.find(([, plan]) => plan !== undefined);
  return found?.[1] ? { booking: found[0], plan: found[1] } : null;
}

type SeatPayment = OutcomePartiesRow["payment"][number];

/** Legs an organisation funded; the refund cascade returns each to the organisation, never to the learner's card. */
const ORGANISATION_LEGS = new Set<string>([
  "WALLET",
  "INVOICE_ACCRUAL",
  "OVERAGE_INVOICE_ACCRUAL",
  "LICENSE",
]);

/** Where a refund of these payments goes: the learner's own legs (card, referral credit), the organisation's, or both. */
export function refundDestinationOf(
  payments: readonly Pick<SeatPayment, "legs">[],
): RefundDestination {
  const funded = payments
    .flatMap((p) => p.legs)
    .filter((l) => l.amountPaise > 0);
  const organisation = funded.some((l) => ORGANISATION_LEGS.has(l.source));
  const own =
    funded.length === 0 || funded.some((l) => !ORGANISATION_LEGS.has(l.source));
  if (organisation && own) return "split";
  return organisation ? "organisation" : "you";
}

type Seat = OutcomePartiesRow["participants"][number];

/** A seat held the session when it existed before the session started (`seatJoinedAt`). */
const seatHeld = (seat: Seat, startsAt: Date) => startsAt > seatJoinedAt(seat);

/**
 * One learner's refund for this session: the captured payments settlement
 * would refund for this seat (its own payment, or any in the learner's name on
 * a legacy seat) that `seatSessionClaim` owes automatically and that carry no
 * live refund under this session's key yet. A 1:1 consultation names the
 * amount; a group seat's per-session share is left unnamed.
 */
function seatRefundOf(
  row: OutcomePartiesRow,
  booking: NoticeBooking,
  seat: Seat,
  session: { occurrenceId: string; startsAt: Date },
): { refund: SeatRefund | null; alreadyRefunded: boolean } {
  if (
    booking !== "consultation" &&
    booking !== "class" &&
    booking !== "webinar"
  ) {
    return { refund: null, alreadyRefunded: false };
  }
  const claimed = row.payment.filter(
    (p) =>
      p.userId === seat.userId &&
      (seat.paymentId === null || seat.paymentId === p.id) &&
      seatSessionClaim(session, seat, p) === "refund",
  );
  const spent = (p: (typeof claimed)[number]) =>
    sessionRefundSpent(
      p.refunds,
      occurrenceRefundKey(session.occurrenceId, p.id),
    );
  const owed = claimed.filter((p) => !spent(p));
  const alreadyRefunded = owed.length < claimed.length;
  const paise = owed.reduce(
    (sum, p) => sum + refundableBalancePaise(Number(p.amount), p),
    0,
  );
  const currency = owed[0]?.currency;
  if (paise <= 0 || !currency) return { refund: null, alreadyRefunded };
  return {
    refund: {
      amountText:
        booking === "consultation"
          ? formatNotificationMoney(paise, currency)
          : null,
      destination: refundDestinationOf(owed),
    },
    alreadyRefunded: false,
  };
}

interface Party {
  userId: string;
  side: NoticeSide;
  consultantProfileId: string | null;
  consulteeProfileId: string | null;
  /** A learner's refund, if their seat's verdict voids it. */
  refund: SeatRefund | null;
  /** A learner whose seat this session was already refunded for, under settlement's own key. */
  alreadyRefunded: boolean;
}

/** The hosts the session had, and the learner seats that held it: a seat taken after it started was never in it. */
async function readParties(
  appointmentId: string,
  session: { occurrenceId: string; startsAt: Date; endsAt: Date },
) {
  const { startsAt } = session;
  const row = await readPartiesRow(appointmentId);
  const shape = row ? bookingOf(row) : null;
  if (!row || !shape) return null;
  const hosts = sessionHostUserIds(row, session);
  const heldSeats = row.participants.filter(
    (p) => !hosts.includes(p.userId) && seatHeld(p, startsAt),
  );
  const learners = heldSeats.map((p) => p.userId);
  const ids = [...new Set([...hosts, ...learners])];
  const users = await prisma.user.findMany({
    where: { id: { in: ids } },
    select: { id: true, consultantProfileId: true, consulteeProfileId: true },
  });
  const byId = new Map(users.map((u) => [u.id, u]));
  const seats = new Map(heldSeats.map((p) => [p.userId, p]));
  const parties: Party[] = ids.map((userId) => {
    const seat = hosts.includes(userId) ? undefined : seats.get(userId);
    const owed = seat
      ? seatRefundOf(row, shape.booking, seat, session)
      : { refund: null, alreadyRefunded: false };
    return {
      userId,
      side: seat ? "learner" : "host",
      consultantProfileId: byId.get(userId)?.consultantProfileId ?? null,
      consulteeProfileId: byId.get(userId)?.consulteeProfileId ?? null,
      ...owed,
    };
  });
  return { row, ...shape, parties };
}

/** The recipient's own support request page for this booking, opened on a no-show report about this session. */
export function reportHref(
  party: Pick<Party, "side" | "consultantProfileId" | "consulteeProfileId">,
  appointmentId: string,
  occurrenceId: string,
): string {
  const page = `support/requests/${caseKeyOf({ kind: "booking", id: appointmentId })}`;
  const query = `?intent=NO_SHOW&occurrence=${encodeURIComponent(occurrenceId)}`;
  let base: string;
  if (party.side === "host" && party.consultantProfileId) {
    base = `/dashboard/consultant/${party.consultantProfileId}/${page}`;
  } else if (party.side === "learner" && party.consulteeProfileId) {
    base = `/dashboard/consultee/${party.consulteeProfileId}/${page}`;
  } else {
    base = goHref("auto", page);
  }
  return `${getAppUrl()}${base}${query}`;
}

/** Bells and emails rendered before the transaction, staged inside it by {@link stageOutcomeNotices}. */
export interface PreparedOutcomeNotices {
  entityRef: string;
  bells: PreparedBell[];
  emails: ScreenedRecipientEmails;
}

export interface StagedOutcomeNotices {
  bells: StagedTrigger[];
  emails: StagedRecipientEmail[];
}

type Built = { copy: NoticeCopy; href: string };

async function prepare(args: {
  workflowId:
    | typeof NOVU_WORKFLOWS.SESSION_OUTCOME_PROPOSED
    | typeof NOVU_WORKFLOWS.SESSION_OUTCOME_REVIEWED;
  emailType: "SESSION_OUTCOME_PROPOSED" | "SESSION_OUTCOME_REVIEWED";
  appointmentId: string;
  parties: Party[];
  dedupeKey: (userId: string) => string;
  build: (party: Party, zone: string) => Built;
  payload: (
    party: Party,
    zone: string,
    built: Built,
  ) => SessionOutcomeProposedPayload | SessionOutcomeReviewedPayload;
}): Promise<PreparedOutcomeNotices> {
  const byId = new Map(args.parties.map((p) => [p.userId, p]));
  const userIds = args.parties.map((p) => p.userId);
  const [zones, emails] = await Promise.all([
    bellRecipientZones(args.workflowId, userIds),
    prepareSessionOutcomeNoticeEmails({
      emailType: args.emailType,
      appointmentId: args.appointmentId,
      userIds,
      noticeFor: (userId, zone) => {
        const party = byId.get(userId);
        if (!party) throw new Error(`${userId} is not a party to this session`);
        return args.build(party, zone);
      },
    }),
  ]);
  const bells: PreparedBell[] = [];
  for (const party of args.parties) {
    const zone = zones.get(party.userId);
    if (zone === undefined) continue;
    bells.push({
      workflowId: args.workflowId,
      kind: "SINGLE",
      recipients: [party.userId],
      payload: args.payload(party, zone, args.build(party, zone)),
      dedupeKey: args.dedupeKey(party.userId),
      entityRef: `appointment:${args.appointmentId}`,
    });
  }
  return { entityRef: `appointment:${args.appointmentId}`, bells, emails };
}

const when = (date: Date, zone: string) =>
  formatNotificationDateTime(date, zone) ?? date.toISOString();

/** When a verdict written at `outcomeAt` stops taking reports. */
const windowClosesAt = (outcomeAt: Date) =>
  new Date(outcomeAt.getTime() + OUTCOME_REPORT_WINDOW_HOURS * 3_600_000);

export interface OutcomeNoticeSession {
  occurrenceId: string;
  appointmentId: string;
  startsAt: Date;
  endsAt: Date;
}

/**
 * The proposed-verdict notice to every host and live learner seat: what was
 * recorded, the window's close in their zone, what silence does and the report link.
 */
export async function prepareProposedOutcomeNotices(
  session: OutcomeNoticeSession & {
    outcome: NegativeMoneyOutcome;
    outcomeAt: Date;
  },
): Promise<PreparedOutcomeNotices | null> {
  const read = await readParties(session.appointmentId, session);
  if (!read || read.parties.length === 0) return null;
  const { row, booking, plan, parties } = read;
  const closesAt = windowClosesAt(session.outcomeAt);
  const hasRecording =
    session.outcome === "LEARNER_ABSENT" &&
    plan.recordingEnabled &&
    (await prisma.recording.count({
      where: {
        meeting: { appointmentOccurrenceId: session.occurrenceId },
        status: { in: ["READY", "AVAILABLE"] },
      },
    })) > 0;
  const build = (party: Party, zone: string): Built => ({
    copy: proposedNoticeCopy({
      outcome: session.outcome,
      side: party.side,
      booking,
      planTitle: plan.title,
      sessionWhen: when(session.startsAt, zone),
      windowClosesWhen: when(closesAt, zone),
      refund: party.refund,
      alreadyRefunded: party.alreadyRefunded,
      hasRecording,
    }),
    href: reportHref(party, session.appointmentId, session.occurrenceId),
  });
  return prepare({
    workflowId: NOVU_WORKFLOWS.SESSION_OUTCOME_PROPOSED,
    emailType: "SESSION_OUTCOME_PROPOSED",
    appointmentId: session.appointmentId,
    parties,
    dedupeKey: (userId) =>
      `session-outcome-proposed:${session.occurrenceId}:${session.outcomeAt.getTime()}:${userId}`,
    build,
    payload: (party, zone, { copy, href }) => ({
      ...notificationScope(row.organizationId),
      appointmentId: session.appointmentId,
      occurrenceId: session.occurrenceId,
      outcome: session.outcome,
      side: party.side,
      planTitle: plan.title,
      dateTime: when(session.startsAt, zone),
      subject: copy.subject,
      message: copy.lines.join(" "),
      windowClosesAt: when(closesAt, zone),
      windowClosesAtIso: closesAt.toISOString(),
      reportUrl: href,
    }),
  });
}

/** The short notice to both sides that ops reviewed a negative verdict and what the record now shows. */
export async function prepareReviewedOutcomeNotices(
  session: OutcomeNoticeSession & {
    outcome: OccurrenceOutcome;
    reviewedAt: Date;
  },
): Promise<PreparedOutcomeNotices | null> {
  const read = await readParties(session.appointmentId, session);
  if (!read || read.parties.length === 0) return null;
  const { row, plan, parties } = read;
  const href = `${getAppUrl()}${goHref("auto", `appointments/${session.appointmentId}`)}`;
  const build = (party: Party, zone: string): Built => ({
    copy: reviewedNoticeCopy({
      outcome: session.outcome,
      side: party.side,
      planTitle: plan.title,
      sessionWhen: when(session.startsAt, zone),
    }),
    href,
  });
  return prepare({
    workflowId: NOVU_WORKFLOWS.SESSION_OUTCOME_REVIEWED,
    emailType: "SESSION_OUTCOME_REVIEWED",
    appointmentId: session.appointmentId,
    parties,
    dedupeKey: (userId) =>
      `session-outcome-reviewed:${session.occurrenceId}:${session.reviewedAt.getTime()}:${userId}`,
    build,
    payload: (party, zone, { copy }) => ({
      ...notificationScope(row.organizationId),
      appointmentId: session.appointmentId,
      occurrenceId: session.occurrenceId,
      outcome: session.outcome,
      side: party.side,
      planTitle: plan.title,
      dateTime: when(session.startsAt, zone),
      subject: copy.subject,
      message: copy.lines.join(" "),
      dashboardUrl: href,
    }),
  });
}

/** Stages prepared notices on the writing transaction: one insert for the bells, one per email. */
export async function stageOutcomeNotices(
  tx: Pick<Tx, "notificationOutbox" | "failedEmail">,
  prepared: PreparedOutcomeNotices,
): Promise<StagedOutcomeNotices> {
  const bells = await stagePreparedBells(tx, prepared.bells);
  const emails = await stageScreenedEmails(
    tx,
    prepared.emails,
    prepared.entityRef,
  );
  return { bells, emails };
}
