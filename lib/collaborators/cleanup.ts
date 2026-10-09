import prisma from "@/lib/prisma";
import { withCronLock } from "@/lib/cron/with-cron-lock";
import { EMAIL_BUDGET_MS } from "@/lib/email";
import { sendCollaboratorInviteExpiredEmail } from "@/lib/email/senders/collaborators";

const STALE_INVITE_MS = 14 * 24 * 60 * 60 * 1000;

export interface ExpireStaleCollaboratorInvitesResult {
  expired: number;
  scanned: number;
}

/**
 * Transitions PENDING collaborator invitations older than 14 days to DECLINED
 * via conditional CAS update and notifies inviter and invitee.
 */
export async function expireStaleCollaboratorInvites(
  limit = 25,
): Promise<ExpireStaleCollaboratorInvitesResult> {
  return withCronLock(
    "expire-stale-collaborator-invites",
    { failMode: "open" },
    async () => {
      const now = new Date();
      const cutoff = new Date(now.getTime() - STALE_INVITE_MS);

      const candidates = await prisma.collaborator.findMany({
        where: {
          status: "PENDING",
          updatedAt: { lt: cutoff },
        },
        take: Math.max(1, Math.min(limit, 500)),
        orderBy: { updatedAt: "asc" },
        select: {
          id: true,
          collaboratorType: true,
          role: true,
          revenueShareBps: true,
          consultantProfile: {
            select: {
              user: { select: { id: true, name: true } },
            },
          },
          invitedBy: {
            select: {
              user: { select: { id: true, name: true } },
            },
          },
          webinarPlan: {
            select: {
              title: true,
              consultantProfile: {
                select: {
                  user: { select: { id: true, name: true } },
                },
              },
            },
          },
          classPlan: {
            select: {
              title: true,
              consultantProfile: {
                select: {
                  user: { select: { id: true, name: true } },
                },
              },
            },
          },
        },
      });

      let expired = 0;

      for (const c of candidates) {
        const updated = await prisma.collaborator.updateMany({
          where: { id: c.id, status: "PENDING" },
          data: { status: "DECLINED", respondedAt: now },
        });
        if (updated.count === 0) continue;

        expired += 1;

        const planType = c.collaboratorType === "WEBINAR" ? "webinar" : "class";
        const plan =
          c.collaboratorType === "WEBINAR" ? c.webinarPlan : c.classPlan;
        const planTitle =
          plan?.title ??
          (planType === "webinar" ? "Untitled webinar" : "Untitled class");
        const inviteeUser = c.consultantProfile.user;
        const inviterUser =
          c.invitedBy?.user ?? plan?.consultantProfile?.user ?? null;

        const emailSends: Promise<unknown>[] = [
          sendCollaboratorInviteExpiredEmail(
            {
              recipientUserId: inviteeUser.id,
              actorName: inviterUser?.name ?? "Plan host",
              collaboratorName: inviteeUser.name ?? "Collaborator",
              planTitle,
              planType,
              role: c.role,
              revenueShareBps: c.revenueShareBps,
              collaboratorId: c.id,
            },
            EMAIL_BUDGET_MS.JOB,
          ),
        ];

        if (inviterUser?.id && inviterUser.id !== inviteeUser.id) {
          emailSends.push(
            sendCollaboratorInviteExpiredEmail(
              {
                recipientUserId: inviterUser.id,
                actorName: inviteeUser.name ?? "Collaborator",
                collaboratorName: inviteeUser.name ?? "Collaborator",
                planTitle,
                planType,
                role: c.role,
                revenueShareBps: c.revenueShareBps,
                collaboratorId: c.id,
              },
              EMAIL_BUDGET_MS.JOB,
            ),
          );
        }

        await Promise.allSettled(emailSends);
      }

      return { expired, scanned: candidates.length };
    },
  );
}
