import type { Collaborator } from "@prisma/client";
import {
  cohostChangeSentence,
  type CohostChangeEvent,
  type CollaborationLifecycleEvent,
} from "@/emails/collaborations/CollaborationLifecycleEmail";
import { rolesWithOrgPermission } from "@/lib/auth/org-permissions";
import { paidParticipant } from "@/lib/booking/participants";
import type { Tx } from "@/lib/prisma";
import { goHref } from "@/lib/dashboard/go";
import {
  stageCohostChangeEmails,
  stageCollaboratorLifecycleEmail,
} from "@/lib/email/senders/collaborators";
import type { StagedRecipientEmail } from "@/lib/email/send-to-recipients";
import {
  REQUIRED_NOTICE_FIELD,
  type RequiredNoticeKind,
} from "@/lib/notifications/required-notices";
import {
  collaboratorRoleLabel,
  formatNotificationDateTime,
} from "@/lib/novu/humanize";
import { stagePages, type StagedTrigger } from "@/lib/novu/outbox";
import { resolveRecipientBellPolicy } from "@/lib/novu/policy";
import { stageBell } from "@/lib/novu/stage-bell";
import type { StagedNotificationBundle } from "@/lib/novu/stage-then-attempt";
import {
  NOVU_WORKFLOWS,
  notificationScope,
  type CollaboratorNoticePayload,
  type PlanCohostChangePayload,
} from "@/lib/novu/workflows";
import { getAppUrl } from "@/lib/url";
import { isPresenterRole } from "./roles";
import { inviteExpiresAt } from "./rules";
import { livePlanAppointmentsWhere, type PlanRef } from "./team";

const WORKFLOWS = {
  INVITED: NOVU_WORKFLOWS.COLLABORATOR_INVITED,
  TERMS_CHANGED: NOVU_WORKFLOWS.COLLABORATOR_TERMS_CHANGED,
  ACCEPTED: NOVU_WORKFLOWS.COLLABORATOR_ACCEPTED,
  DECLINED: NOVU_WORKFLOWS.COLLABORATOR_DECLINED,
  REMOVED: NOVU_WORKFLOWS.COLLABORATOR_REMOVED,
  WITHDRAWN: NOVU_WORKFLOWS.COLLABORATOR_WITHDRAWN,
  EXPIRED: NOVU_WORKFLOWS.COLLABORATOR_INVITE_EXPIRED,
  EXPIRING_SOON: NOVU_WORKFLOWS.COLLABORATOR_INVITE_EXPIRING,
} as const;

/**
 * Who hears each transition: the party that did not make it. An accept also
 * mails the collaborator their own copy of the terms, and a lapse reaches both.
 */
const AUDIENCE: Record<
  CollaborationLifecycleEvent,
  { collaborator: "bell+email" | "email" | null; host: boolean }
> = {
  INVITED: { collaborator: "bell+email", host: false },
  TERMS_CHANGED: { collaborator: "bell+email", host: false },
  EXPIRING_SOON: { collaborator: "bell+email", host: false },
  REMOVED: { collaborator: "bell+email", host: false },
  ACCEPTED: { collaborator: "email", host: true },
  DECLINED: { collaborator: null, host: true },
  WITHDRAWN: { collaborator: null, host: true },
  EXPIRED: { collaborator: "bell+email", host: true },
};

/** Every lifecycle notice is required except the reminder before an invitation lapses. */
const REQUIRED: RequiredNoticeKind = "COLLABORATION_CHANGED";
const requiredFor = (
  event: CollaborationLifecycleEvent,
): RequiredNoticeKind | undefined =>
  event === "EXPIRING_SOON" ? undefined : REQUIRED;

/** The row fields a lifecycle notice reads; `updatedAt` keys a re-invite apart. */
export type CollaboratorNoticeRow = Pick<
  Collaborator,
  | "id"
  | "consultantProfileId"
  | "webinarPlanId"
  | "classPlanId"
  | "invitedById"
  | "role"
  | "revenueShareBps"
  | "acceptedAt"
  | "endedByUserId"
  | "updatedAt"
>;

const PERSON = {
  userId: true,
  user: { select: { name: true, erasedAt: true } },
} as const;

type Person = {
  userId: string;
  user: { name: string | null; erasedAt: Date | null } | null;
} | null;

const nameOf = (p: Person): string | undefined =>
  p?.user && !p.user.erasedAt && p.user.name ? p.user.name : undefined;

const PLAN_SELECT = {
  title: true,
  organizationId: true,
  organization: { select: { name: true } },
  consultantProfile: { select: PERSON },
} as const;

/** The dedupe key of one row's notice of one event; a re-invite or an edit moves `updatedAt`. */
function collaboratorNoticeKey(
  row: Pick<Collaborator, "id" | "updatedAt">,
  event: CollaborationLifecycleEvent | CohostChangeEvent,
): string {
  return `${row.id}:${event}:${row.updatedAt.toISOString()}`;
}

/**
 * The plan's host side: its owning expert, or on a plan with none the
 * organisation's active members who manage its catalogue. Whoever sent the
 * invitation is not on it for that reason alone.
 */
async function hostSideUserIds(
  tx: Tx,
  plan: {
    organizationId: string | null;
    consultantProfile: Person;
  } | null,
): Promise<string[]> {
  if (plan?.consultantProfile) return [plan.consultantProfile.userId];
  if (!plan?.organizationId) return [];
  const members = await tx.membership.findMany({
    where: {
      organizationId: plan.organizationId,
      status: "ACTIVE",
      role: { in: rolesWithOrgPermission("catalog.manage") },
    },
    select: { userId: true },
    orderBy: { userId: "asc" },
  });
  return [...new Set(members.map((m) => m.userId))];
}

/** The users holding a paid seat on any of the plan's live events. */
async function seatHolderUserIds(tx: Tx, ref: PlanRef): Promise<string[]> {
  const seats = await tx.appointmentParticipant.findMany({
    where: {
      ...paidParticipant(),
      role: "CONSULTEE",
      appointment: livePlanAppointmentsWhere(ref),
    },
    select: { userId: true },
    distinct: ["userId"],
    orderBy: { userId: "asc" },
  });
  return seats.map((s) => s.userId);
}

/**
 * Tells a plan's seat holders that its named co-presenter joined or left. The
 * notice is required and says nothing beyond the fact.
 */
async function stageCohostChange(
  tx: Tx,
  event: CohostChangeEvent,
  row: CollaboratorNoticeRow,
  ref: PlanRef,
  plan: { title: string; organizationId: string | null },
  cohost: { userId: string | undefined; name: string | null },
): Promise<StagedNotificationBundle> {
  const seatHolders = (await seatHolderUserIds(tx, ref)).filter(
    (userId) => userId !== cohost.userId,
  );
  if (seatHolders.length === 0) return {};
  const workflowId =
    event === "COHOST_JOINED"
      ? NOVU_WORKFLOWS.PLAN_COHOST_JOINED
      : NOVU_WORKFLOWS.PLAN_COHOST_LEFT;
  const payload: PlanCohostChangePayload = {
    planTitle: plan.title,
    sentence: cohostChangeSentence(event, cohost.name, plan.title),
    dashboardUrl: `${getAppUrl()}${goHref("client", "appointments")}`,
  };
  const { allowedRecipients } = await resolveRecipientBellPolicy(
    workflowId,
    seatHolders,
    { tx, required: true },
  );
  const bells = await stagePages(tx, {
    workflowId,
    recipients: allowedRecipients,
    payload: { ...payload, [REQUIRED_NOTICE_FIELD]: "COHOST_CHANGED" },
    dedupeKey: collaboratorNoticeKey(row, event),
    entityRef: `collaborator:${row.id}`,
  });
  const emails = await stageCohostChangeEmails(tx, {
    event,
    userIds: seatHolders,
    cohostName: cohost.name,
    planTitle: plan.title,
    planType: ref.planType,
    collaboratorId: row.id,
  });
  return { bells, emails: [emails] };
}

/**
 * Stages one transition's bells and emails inside its transaction, to the
 * party that did not make it. When the plan's named co-presenter joins or
 * leaves the team, its seat holders are told as well.
 */
export async function stageCollaboratorNotifications(
  tx: Tx,
  event: CollaborationLifecycleEvent,
  row: CollaboratorNoticeRow,
  opts: { collaboratorName?: string } = {},
): Promise<StagedNotificationBundle> {
  const planId = row.webinarPlanId ?? row.classPlanId;
  if (!planId) return {};
  const ref: PlanRef = {
    planType: row.webinarPlanId ? "webinar" : "class",
    planId,
  };
  const plan =
    ref.planType === "webinar"
      ? await tx.webinarPlan.findUnique({
          where: { id: planId },
          select: PLAN_SELECT,
        })
      : await tx.classPlan.findUnique({
          where: { id: planId },
          select: PLAN_SELECT,
        });
  const invitee: Person = await tx.consultantProfile.findUnique({
    where: { id: row.consultantProfileId },
    select: PERSON,
  });
  const owner: Person = plan?.consultantProfile ?? null;
  if (
    event === "EXPIRING_SOON" &&
    !(invitee && (await claimReminder(tx, row, invitee.userId)))
  ) {
    return {};
  }

  // A manager who ends their own row left or declined; nobody removed them.
  const selfEnded =
    event === "REMOVED" &&
    row.endedByUserId !== null &&
    row.endedByUserId === invitee?.userId;
  const wasOnTeam = row.acceptedAt !== null;
  const told: CollaborationLifecycleEvent = selfEnded
    ? wasOnTeam
      ? "WITHDRAWN"
      : "DECLINED"
    : event;
  const audience = AUDIENCE[told];

  const planTitle =
    plan?.title ?? (ref.planType === "webinar" ? "Webinar" : "Class");
  const collaboratorName =
    opts.collaboratorName ?? nameOf(invitee) ?? "A collaborator";
  const actorName = await actorNameOf(tx, told, row, {
    owner,
    orgName: owner ? undefined : plan?.organization?.name,
  });
  const pendingInvite = told === "REMOVED" && !wasOnTeam;
  const expiresAt =
    told === "INVITED" || told === "TERMS_CHANGED" || told === "EXPIRING_SOON"
      ? inviteExpiresAt(row.updatedAt)
      : undefined;
  const required = requiredFor(told);
  const base = {
    planTitle,
    planType: ref.planType,
    collaboratorName,
    ...(actorName ? { ownerName: actorName } : {}),
    role: collaboratorRoleLabel(row.role),
    revenueSharePercentage: row.revenueShareBps / 100,
    ...(expiresAt ? { expiresOn: formatNotificationDateTime(expiresAt) } : {}),
    ...(pendingInvite ? { pendingInvite: true } : {}),
  };
  const collaboratorUrl = goHref("expert", "collaborations");
  const hostUrl = plan?.organizationId
    ? `/dashboard/organization/${plan.organizationId}/collaborations`
    : collaboratorUrl;

  const bells: (StagedTrigger | null)[] = [];
  const list: StagedRecipientEmail[] = [];
  const mail = (recipientUserId: string, toCollaborator: boolean) =>
    stageCollaboratorLifecycleEmail(tx, {
      event: told,
      recipientUserId,
      toCollaborator,
      actorName,
      collaboratorName,
      planTitle,
      planType: ref.planType,
      role: row.role,
      revenueShareBps: row.revenueShareBps,
      collaboratorId: row.id,
      pendingInvite,
      expiresAt,
      dashboardUrl: toCollaborator ? collaboratorUrl : hostUrl,
    });

  if (audience.collaborator && invitee) {
    if (audience.collaborator === "bell+email") {
      const payload: CollaboratorNoticePayload = {
        ...base,
        dashboardUrl: `${getAppUrl()}${collaboratorUrl}`,
      };
      bells.push(
        await stageBell(tx, {
          workflowId: WORKFLOWS[told],
          recipients: [invitee.userId],
          dedupeKey: collaboratorNoticeKey(row, told),
          entityRef: `collaborator:${row.id}`,
          payload,
          required,
        }),
      );
    }
    list.push(...(await mail(invitee.userId, true)));
  }
  if (audience.host) {
    // Whoever ended the row, and the collaborator, already know.
    const hosts = (await hostSideUserIds(tx, plan)).filter(
      (userId) => userId !== invitee?.userId && userId !== row.endedByUserId,
    );
    if (hosts.length > 0) {
      const payload: CollaboratorNoticePayload = {
        ...base,
        ...notificationScope(plan?.organizationId),
        dashboardUrl: `${getAppUrl()}${hostUrl}`,
      };
      bells.push(
        await stageBell(tx, {
          workflowId: WORKFLOWS[told],
          recipients: hosts,
          dedupeKey: `${collaboratorNoticeKey(row, told)}:host`,
          entityRef: `collaborator:${row.id}`,
          payload,
          required,
        }),
      );
      for (const userId of hosts) list.push(...(await mail(userId, false)));
    }
  }

  const bundle: StagedNotificationBundle = {
    bells,
    emails: [{ list, emailType: `collaborator_${told.toLowerCase()}` }],
  };
  // Seat holders hear of a co-presenter who joined, or who left the team.
  const cohostEvent: CohostChangeEvent | null = !isPresenterRole(row.role)
    ? null
    : told === "ACCEPTED"
      ? "COHOST_JOINED"
      : wasOnTeam && (told === "WITHDRAWN" || told === "REMOVED")
        ? "COHOST_LEFT"
        : null;
  if (!cohostEvent || !plan) return bundle;
  const learners = await stageCohostChange(tx, cohostEvent, row, ref, plan, {
    userId: invitee?.userId,
    name: opts.collaboratorName ? null : (nameOf(invitee) ?? null),
  });
  return {
    bells: [...bells, ...(learners.bells ?? [])],
    emails: [...(bundle.emails ?? []), ...(learners.emails ?? [])],
  };
}

/**
 * Claims the one reminder an invitation gets for its current terms. The claim
 * commits with the notice, so a second run finds it and stages nothing.
 */
async function claimReminder(
  tx: Tx,
  row: CollaboratorNoticeRow,
  userId: string,
): Promise<boolean> {
  const key = collaboratorNoticeKey(row, "EXPIRING_SOON");
  const claimed = await tx.idempotencyRecord.createMany({
    data: [
      {
        scope: "collaborator.invite-expiring",
        key,
        userId,
        requestHash: key,
        completedAt: new Date(),
        // Kept until the invitation has lapsed, when no reminder is due.
        expiresAt: inviteExpiresAt(row.updatedAt),
      },
    ],
    skipDuplicates: true,
  });
  return claimed.count === 1;
}

/** The person a notice names as having made the change, when one is known. */
async function actorNameOf(
  tx: Tx,
  told: CollaborationLifecycleEvent,
  row: CollaboratorNoticeRow,
  plan: { owner: Person; orgName: string | undefined },
): Promise<string | undefined> {
  if (told === "INVITED") {
    const inviter: Person = row.invitedById
      ? await tx.consultantProfile.findUnique({
          where: { id: row.invitedById },
          select: PERSON,
        })
      : null;
    return nameOf(inviter) ?? nameOf(plan.owner) ?? plan.orgName;
  }
  if (told !== "REMOVED" || !row.endedByUserId) return undefined;
  if (row.endedByUserId === plan.owner?.userId) return nameOf(plan.owner);
  const ender = await tx.user.findUnique({
    where: { id: row.endedByUserId },
    select: { name: true, erasedAt: true },
  });
  return ender && !ender.erasedAt && ender.name ? ender.name : undefined;
}
