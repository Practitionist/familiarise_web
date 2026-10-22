import type { SupportChatAccessEndReason } from "@prisma/client";
import type { Tx } from "@/lib/prisma";
import { scheduleAfter } from "@/lib/api/after-safe";

type EndDb = Pick<Tx, "supportCaseChatAccess" | "supportCaseEvent">;

export interface EndedChatGrant {
  id: string;
  kind: "READ" | "INTERVENE";
  /** True when Familiarise Support still sits in the channel and must leave after commit. */
  needsLeave: boolean;
}

/** Ends one live grant (CAS on `endedAt`) with a CHAT_ACCESS_ENDED event; false when already ended. */
export async function endChatGrantTx(
  tx: EndDb,
  grant: { id: string; caseId: string; kind: "READ" | "INTERVENE" },
  input: {
    actorId: string | null;
    reason: SupportChatAccessEndReason;
    now: Date;
  },
): Promise<boolean> {
  const ended = await tx.supportCaseChatAccess.updateMany({
    where: { id: grant.id, endedAt: null },
    data: {
      endedAt: input.now,
      endedById: input.actorId,
      endReason: input.reason,
    },
  });
  if (ended.count === 0) return false;
  await tx.supportCaseEvent.create({
    data: {
      caseId: grant.caseId,
      actorId: input.actorId,
      kind: "CHAT_ACCESS_ENDED",
      fromValue: grant.kind,
      toValue: grant.id,
      note: input.reason,
      createdAt: input.now,
    },
  });
  return true;
}

/**
 * Ends every live chat grant on a case inside the caller's transaction (case
 * resolved or closed). Stream membership is never touched here: the caller
 * schedules the leave after commit, and the SLA sweep retries it.
 */
export async function endCaseChatAccessTx(
  tx: EndDb,
  input: {
    caseId: string;
    actorId: string | null;
    reason: SupportChatAccessEndReason;
    now: Date;
  },
): Promise<EndedChatGrant[]> {
  const live = await tx.supportCaseChatAccess.findMany({
    where: { caseId: input.caseId, endedAt: null },
    select: { id: true, kind: true, streamJoinedAt: true, streamLeftAt: true },
  });
  const ended: EndedChatGrant[] = [];
  // One connection per transaction: end each grant in turn.
  for (const grant of live) {
    if (await endChatGrantTx(tx, { ...grant, caseId: input.caseId }, input)) {
      ended.push({
        id: grant.id,
        kind: grant.kind,
        needsLeave:
          grant.kind === "INTERVENE" &&
          grant.streamJoinedAt !== null &&
          grant.streamLeftAt === null,
      });
    }
  }
  return ended;
}

/**
 * Clears Familiarise Support from a case's ended interventions once the
 * request settles. Harmless if the transaction rolled back: it only acts on
 * committed ended-but-seated grants, and the SLA sweep retries any miss.
 */
export function scheduleInterventionLeave(caseId: string): void {
  void scheduleAfter(async () => {
    const { leavePendingInterventions } =
      await import("@/lib/stream/support-intervention");
    await leavePendingInterventions(caseId);
  }, "support.chat.leave");
}
