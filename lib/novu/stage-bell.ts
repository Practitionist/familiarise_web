import type { Tx } from "@/lib/prisma";
import { stageTrigger, type NovuPayload } from "./outbox";
import type { NovuWorkflowId } from "./templates/types";

/**
 * #1775 / #1780 — stage a bell inside the caller's transaction (state-as-outbox,
 * ADR 27): a rollback takes the row with it, the relay drains it after the
 * commit, and the dedupe key makes a second staging of the same event a no-op.
 */
export function stageBell(
  tx: Pick<Tx, "notificationOutbox">,
  args: {
    workflowId: NovuWorkflowId;
    recipients: string[];
    payload: NovuPayload;
    dedupeKey: string;
  },
) {
  return stageTrigger({
    tx,
    ...args,
    kind: args.recipients.length > 1 ? "MULTI" : "SINGLE",
  });
}
