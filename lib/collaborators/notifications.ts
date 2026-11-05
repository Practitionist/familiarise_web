import type { Collaborator } from "@prisma/client";
import type { Tx } from "@/lib/prisma";
import type { CollaborationLifecycleEvent } from "@/emails/collaborations/CollaborationLifecycleEmail";
import { stageCollaboratorLifecycleEmail } from "@/lib/email/senders/collaborators";
import { stageBells } from "@/lib/novu/stage-bell";
import { NOVU_WORKFLOWS } from "@/lib/novu/workflows";
import { collaboratorRoleLabel } from "@/lib/novu/humanize";
import { goHref } from "@/lib/dashboard/go";
import { getAppUrl } from "@/lib/url";
import type { StagedNotificationBundle } from "@/lib/novu/stage-then-attempt";

const WORKFLOWS = {
  INVITED: NOVU_WORKFLOWS.COLLABORATOR_INVITED,
  ACCEPTED: NOVU_WORKFLOWS.COLLABORATOR_ACCEPTED,
  DECLINED: NOVU_WORKFLOWS.COLLABORATOR_DECLINED,
  REMOVED: NOVU_WORKFLOWS.COLLABORATOR_REMOVED,
  WITHDRAWN: NOVU_WORKFLOWS.COLLABORATOR_WITHDRAWN,
  EXPIRED: NOVU_WORKFLOWS.COLLABORATOR_INVITE_EXPIRED,
} as const;

/** Recipient reads and both channels commit with the collaborator transition. */
export async function stageCollaboratorNotifications(
  tx: Tx,
  event: CollaborationLifecycleEvent,
  collaborator: Collaborator,
  displayName?: string,
): Promise<StagedNotificationBundle> {
  const planId = collaborator.webinarPlanId ?? collaborator.classPlanId;
  if (!planId) return {};
  const planType = collaborator.webinarPlanId ? "webinar" : "class";
  const select = {
    title: true,
    consultantProfile: {
      select: {
        userId: true,
        user: { select: { name: true, erasedAt: true } },
      },
    },
  } as const;
  const plan =
    planType === "webinar"
      ? await tx.webinarPlan.findUnique({ where: { id: planId }, select })
      : await tx.classPlan.findUnique({ where: { id: planId }, select });
  const invitee = await tx.consultantProfile.findUnique({
    where: { id: collaborator.consultantProfileId },
    select: { userId: true, user: { select: { name: true, erasedAt: true } } },
  });
  const inviter = collaborator.invitedById
    ? await tx.consultantProfile.findUnique({
        where: { id: collaborator.invitedById },
        select: {
          userId: true,
          user: { select: { name: true, erasedAt: true } },
        },
      })
    : null;
  const hostUserId =
    event === "EXPIRED"
      ? (inviter?.userId ?? plan?.consultantProfile?.userId)
      : (plan?.consultantProfile?.userId ?? inviter?.userId);
  const participantEvent = event === "INVITED" || event === "REMOVED";
  const recipients = [
    ...new Set(
      event === "EXPIRED"
        ? [invitee?.userId, hostUserId].filter((id): id is string =>
            Boolean(id),
          )
        : [participantEvent ? invitee?.userId : hostUserId].filter(
            (id): id is string => Boolean(id),
          ),
    ),
  ];
  if (recipients.length === 0) return {};
  const planTitle =
    plan?.title ?? (planType === "webinar" ? "Webinar" : "Class");
  const collaboratorName =
    displayName ??
    (invitee?.user?.erasedAt
      ? "A collaborator"
      : (invitee?.user?.name ?? "A collaborator"));
  const ownerName =
    event === "REMOVED"
      ? (plan?.consultantProfile?.user?.name ??
        inviter?.user?.name ??
        "Plan Owner")
      : (inviter?.user?.name ??
        plan?.consultantProfile?.user?.name ??
        "Plan Owner");
  const revision = `${collaborator.id}:${event}:${collaborator.updatedAt.toISOString()}`;
  const bell = await stageBells(tx, {
    workflowId: WORKFLOWS[event],
    recipients,
    dedupeKey: revision,
    entityRef: `collaborator:${collaborator.id}`,
    payload: {
      planTitle,
      planType,
      collaboratorName,
      ownerName,
      role: collaboratorRoleLabel(collaborator.role),
      revenueSharePercentage: collaborator.revenueShareBps / 100,
      dashboardUrl: `${getAppUrl()}${goHref("expert", "collaborations")}`,
    },
  });
  const emailLists = [];
  for (const recipientUserId of recipients) {
    emailLists.push(
      await stageCollaboratorLifecycleEmail(
        tx,
        event,
        {
          recipientUserId,
          actorName:
            recipientUserId === invitee?.userId ? ownerName : collaboratorName,
          collaboratorName,
          planTitle,
          planType,
          role: collaborator.role,
          revenueShareBps: collaborator.revenueShareBps,
          collaboratorId: collaborator.id,
        },
        revision,
      ),
    );
  }
  return {
    bells: bell,
    emails: [
      {
        list: emailLists.flat(),
        emailType: `collaborator_${event.toLowerCase()}`,
      },
    ],
  };
}
