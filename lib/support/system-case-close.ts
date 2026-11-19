// What a case closed by the system, with no human acting, gives back in its closing transaction.

import type { Tx } from "@/lib/prisma";
import { releaseAllCaseHolds } from "./case-holds";
import { endCaseChatAccessTx } from "./chat-access-end";
import { recordLifecycleHoldReleaseTx } from "./case-service";

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
  // A sweep's chat arm clears Familiarise Support from any grant still seated.
  await endCaseChatAccessTx(tx, {
    caseId,
    actorId: null,
    reason: "CASE_RESOLVED",
    now,
  });
}
