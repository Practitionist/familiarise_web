import type { Tx } from "@/lib/prisma";
import { stageTrigger, type NovuPayload, type StagedTrigger } from "./outbox";
import { resolveRecipientBellPolicy } from "./policy";
import type { NovuWorkflowId } from "./templates/types";

export type StageBellTx = Pick<Tx, "notificationOutbox"> &
  Partial<Pick<Tx, "user">>;

/**
 * Stage an in-app bell inside the caller's transaction after enforcing
 * recipient workspace routing, channel/category preferences, and quiet hours.
 */
export async function stageBell(
  tx: StageBellTx,
  args: {
    workflowId: NovuWorkflowId;
    recipients: string[];
    payload: NovuPayload;
    dedupeKey: string;
    entityRef?: string;
    deferrable?: boolean;
  },
): Promise<StagedTrigger | null> {
  if (!tx.notificationOutbox) return null;
  if (args.recipients.length === 0) return null;
  const policy = await resolveRecipientBellPolicy(
    args.workflowId,
    args.recipients,
    { tx, deferrable: args.deferrable },
  );
  if (policy.allowedRecipients.length === 0) return null;
  return stageTrigger({
    tx,
    ...args,
    recipients: policy.allowedRecipients,
    ...(policy.notBefore ? { notBefore: policy.notBefore } : {}),
    kind: policy.allowedRecipients.length > 1 ? "MULTI" : "SINGLE",
  });
}
