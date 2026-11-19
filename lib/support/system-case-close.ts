// What a case closed by the system, with no human acting, gives back in its closing transaction.

import type { Tx } from "@/lib/prisma";
import { activeHolds, caseHoldEvents, releaseAllCaseHolds } from "./case-holds";
import { endCaseChatAccessTx } from "./chat-access-end";
import {
  moneyDoorsRefusal,
  openRecommendationTx,
  recordLifecycleHoldReleaseTx,
} from "./case-service";

const moneyDoorsCode = () =>
  moneyDoorsRefusal().then((refusal) => refusal?.code ?? null);

/**
 * Why the system may not release a case's payout holds yet: an undecided refund
 * recommendation, or closed money doors; null when it holds nothing. The doors gate is read lazily.
 */
export async function systemCloseHoldRefusalTx(
  tx: Tx,
  caseId: string,
  doors: () => Promise<string | null> = moneyDoorsCode,
): Promise<string | null> {
  const held = activeHolds(await caseHoldEvents(tx, [caseId]));
  if (held.length === 0) return null;
  if (await openRecommendationTx(tx, caseId)) return "RECOMMENDATION_OPEN";
  return doors();
}

/** Releases the case's payout holds and ends its chat grants, without step-up. */
export async function releaseSystemClosedCaseTx(
  tx: Tx,
  caseId: string,
  now: Date,
  note: string,
): Promise<void> {
  await recordLifecycleHoldReleaseTx(tx, {
    caseId,
    actorId: null,
    actorRole: "SYSTEM",
    status: "CLOSED",
    reason: note,
    released: await releaseAllCaseHolds(tx, { caseId, actorId: null, note }),
  });
  await endSystemClosedChatTx(tx, caseId, now);
}

/** Ends the case's chat grants; a sweep's chat arm clears Familiarise Support from any grant still seated. */
export async function endSystemClosedChatTx(
  tx: Tx,
  caseId: string,
  now: Date,
): Promise<void> {
  await endCaseChatAccessTx(tx, {
    caseId,
    actorId: null,
    reason: "CASE_RESOLVED",
    now,
  });
}
