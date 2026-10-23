import type { SupportChatAccessEndReason } from "@prisma/client";
import type { Tx } from "@/lib/prisma";
import { scheduleAfter } from "@/lib/api/after-safe";

type EndDb = Pick<Tx, "supportCaseChatAccess" | "supportCaseEvent">;

export interface EndedChatGrant {
  id: string;
  kind: "READ" | "INTERVENE";
  channelType: string;
  channelId: string;
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
 * resolved or closed). Stream is never touched here: the caller schedules the
 * leave and the channel unlock after commit, and the SLA sweep retries both.
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
    select: {
      id: true,
      kind: true,
      channelType: true,
      channelId: true,
      streamJoinedAt: true,
      streamLeftAt: true,
    },
  });
  const ended: EndedChatGrant[] = [];
  // One connection per transaction: end each grant in turn.
  for (const grant of live) {
    if (await endChatGrantTx(tx, { ...grant, caseId: input.caseId }, input)) {
      ended.push({
        id: grant.id,
        kind: grant.kind,
        channelType: grant.channelType,
        channelId: grant.channelId,
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
 * Once the request settles, clears Familiarise Support from the case's ended
 * interventions and unlocks the ended grants' channels. Harmless if the
 * transaction rolled back: the leave acts only on committed ended-but-seated
 * grants, the unlock re-reads live grants, and the SLA sweep retries any miss.
 */
export function scheduleChatAccessRelease(
  caseId: string,
  ended: readonly EndedChatGrant[],
): void {
  const channels = new Map(
    ended.map((g) => [`${g.channelType}:${g.channelId}`, g] as const),
  );
  void scheduleAfter(async () => {
    const [{ leavePendingInterventions }, { syncSupportBoundary }] =
      await Promise.all([
        import("@/lib/stream/support-intervention"),
        import("@/lib/stream/support-boundary"),
      ]);
    if (ended.some((g) => g.needsLeave))
      await leavePendingInterventions(caseId);
    for (const g of channels.values())
      await syncSupportBoundary(g.channelType, g.channelId);
  }, "support.chat.release");
}
