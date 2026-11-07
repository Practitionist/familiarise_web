import type { Collaborator } from "@prisma/client";
import type { CollaborationLifecycleEvent } from "@/emails/collaborations/CollaborationLifecycleEmail";
import type { Tx } from "@/lib/prisma";
import { goHref } from "@/lib/dashboard/go";
import { stageCollaboratorLifecycleEmail } from "@/lib/email/senders/collaborators";
import type { StagedRecipientEmail } from "@/lib/email/send-to-recipients";
import { collaboratorRoleLabel } from "@/lib/novu/humanize";
import type { StagedTrigger } from "@/lib/novu/outbox";
import { stageBell } from "@/lib/novu/stage-bell";
import type { StagedNotificationBundle } from "@/lib/novu/stage-then-attempt";
import {
  NOVU_WORKFLOWS,
  type CollaboratorNoticePayload,
} from "@/lib/novu/workflows";
import { getAppUrl } from "@/lib/url";

const WORKFLOWS = {
  INVITED: NOVU_WORKFLOWS.COLLABORATOR_INVITED,
  ACCEPTED: NOVU_WORKFLOWS.COLLABORATOR_ACCEPTED,
  DECLINED: NOVU_WORKFLOWS.COLLABORATOR_DECLINED,
  REMOVED: NOVU_WORKFLOWS.COLLABORATOR_REMOVED,
  WITHDRAWN: NOVU_WORKFLOWS.COLLABORATOR_WITHDRAWN,
  EXPIRED: NOVU_WORKFLOWS.COLLABORATOR_INVITE_EXPIRED,
} as const;

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

const nameOf = (p: Person, fallback: string) =>
  p?.user && !p.user.erasedAt && p.user.name ? p.user.name : fallback;

/**
 * Stages one transition's bell and emails inside its transaction: the invitee
 * hears INVITED and REMOVED, the host every other event, and EXPIRED reaches both.
 */
export async function stageCollaboratorNotifications(
  tx: Tx,
  event: CollaborationLifecycleEvent,
  row: CollaboratorNoticeRow,
  opts: { collaboratorName?: string } = {},
): Promise<StagedNotificationBundle> {
  const planId = row.webinarPlanId ?? row.classPlanId;
  if (!planId) return {};
  const planType = row.webinarPlanId ? "webinar" : "class";
  const select = { title: true, consultantProfile: { select: PERSON } };
  const plan =
    planType === "webinar"
      ? await tx.webinarPlan.findUnique({ where: { id: planId }, select })
      : await tx.classPlan.findUnique({ where: { id: planId }, select });
  const invitee: Person = await tx.consultantProfile.findUnique({
    where: { id: row.consultantProfileId },
    select: PERSON,
  });
  const inviter: Person = row.invitedById
    ? await tx.consultantProfile.findUnique({
        where: { id: row.invitedById },
        select: PERSON,
      })
    : null;
  const owner: Person = plan?.consultantProfile ?? null;
  const host = event === "EXPIRED" ? (inviter ?? owner) : (owner ?? inviter);
  const toInvitee = event === "INVITED" || event === "REMOVED";
  const recipients = [
    ...new Set(
      (event === "EXPIRED"
        ? [invitee?.userId, host?.userId]
        : [toInvitee ? invitee?.userId : host?.userId]
      ).filter((id): id is string => Boolean(id)),
    ),
  ];
  if (recipients.length === 0) return {};

  const planTitle =
    plan?.title ?? (planType === "webinar" ? "Webinar" : "Class");
  const collaboratorName =
    opts.collaboratorName ?? nameOf(invitee, "A collaborator");
  const ownerName = nameOf(
    event === "REMOVED" ? (owner ?? inviter) : (inviter ?? owner),
    "Plan owner",
  );
  const dashboardUrl = `${getAppUrl()}${goHref("expert", "collaborations")}`;
  const payload: CollaboratorNoticePayload = {
    planTitle,
    planType,
    collaboratorName,
    ownerName,
    role: collaboratorRoleLabel(row.role),
    revenueSharePercentage: row.revenueShareBps / 100,
    dashboardUrl,
  };
  const bell: StagedTrigger | null = await stageBell(tx, {
    workflowId: WORKFLOWS[event],
    recipients,
    dedupeKey: `${row.id}:${event}:${row.updatedAt.toISOString()}`,
    entityRef: `collaborator:${row.id}`,
    payload,
  });
  const list: StagedRecipientEmail[] = [];
  for (const recipientUserId of recipients) {
    list.push(
      ...(await stageCollaboratorLifecycleEmail(tx, {
        event,
        recipientUserId,
        actorName:
          recipientUserId === invitee?.userId ? ownerName : collaboratorName,
        collaboratorName,
        planTitle,
        planType,
        role: row.role,
        revenueShareBps: row.revenueShareBps,
        collaboratorId: row.id,
      })),
    );
  }
  return {
    bells: [bell],
    emails: [{ list, emailType: `collaborator_${event.toLowerCase()}` }],
  };
}
