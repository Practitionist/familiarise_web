import type { Tx } from "@/lib/prisma";
import { transitionParticipant } from "@/lib/booking/participants";
import { stageCollaboratorNotifications } from "./notifications";

/** One plan whose collaborator row left PENDING/ACCEPTED; phase 2 revokes it. */
export interface CollaborationRef {
  planType: "webinar" | "class";
  planId: string;
}

/**
 * Transitions active PENDING/ACCEPTED collaborator rows for `targetUserId` to
 * REMOVED, cancels their future collaborator participant rows, stages each
 * host's WITHDRAWN notice, and returns the plans for post-commit Stream revocation.
 */
export async function removeCollaboratorStanding(
  tx: Tx,
  targetUserId: string,
): Promise<CollaborationRef[]> {
  const target = await tx.user.findUnique({
    where: { id: targetUserId },
    select: { consultantProfileId: true },
  });
  if (!target?.consultantProfileId) return [];

  const now = new Date();
  const rows = await tx.collaborator.updateManyAndReturn({
    where: {
      consultantProfileId: target.consultantProfileId,
      status: { in: ["PENDING", "ACCEPTED"] },
    },
    data: { status: "REMOVED", respondedAt: now },
  });
  if (rows.length === 0) return [];

  if (tx.appointmentParticipant) {
    // Through the participant map, so a REFUNDED seat stays terminal.
    await transitionParticipant(
      tx,
      {
        userId: targetUserId,
        role: "COLLABORATOR",
        appointment: {
          deletedAt: null,
          occurrences: {
            some: {
              deletedAt: null,
              startsAt: { gt: now },
            },
          },
        },
      },
      "CANCELLED",
    );
  }

  const plans: CollaborationRef[] = [];
  for (const row of rows) {
    // Unnamed: the account may be leaving through erasure or a ban.
    await stageCollaboratorNotifications(tx, "WITHDRAWN", row, {
      collaboratorName: "A collaborator",
    });
    if (row.webinarPlanId) {
      plans.push({ planType: "webinar", planId: row.webinarPlanId });
    } else if (row.classPlanId) {
      plans.push({ planType: "class", planId: row.classPlanId });
    }
  }
  return plans;
}
