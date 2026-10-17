import type { Tx } from "@/lib/prisma";
import { IllegalTransitionError } from "@/lib/enterprise/transitions";
import { AllocationConflictError } from "@/utils/scheduling-engine/errors";
import { transitionRescheduleRequest } from "./transitions";

/**
 * Closes the proposal an allocation confirms, inside the allocator's
 * transaction: a proposal no longer PENDING_REVIEW rolls the whole move back.
 */
export async function closeConfirmedProposal(
  tx: Tx,
  args: Parameters<typeof transitionRescheduleRequest>[1],
): Promise<void> {
  try {
    await transitionRescheduleRequest(tx, {
      fromIn: ["PENDING_REVIEW"],
      ...args,
    });
  } catch (error) {
    if (!(error instanceof IllegalTransitionError)) throw error;
    throw new AllocationConflictError(
      "This reschedule request was answered or expired while the times were being confirmed.",
      "RESCHEDULE_NO_LONGER_OPEN",
    );
  }
}
