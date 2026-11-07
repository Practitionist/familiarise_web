import type { Tx } from "@/lib/prisma";
import { stageTrigger, type NovuPayload, type StagedTrigger } from "./outbox";
import { resolveRecipientBellPolicy } from "./policy";
import type { NovuWorkflowId } from "./templates/types";

export type StageBellTx = Pick<Tx, "notificationOutbox"> &
  Partial<Pick<Tx, "user">>;

/**
 * Stage an in-app bell inside the caller's transaction after enforcing each
 * recipient's channel and category preferences.
 */
export async function stageBell(
  tx: StageBellTx,
  args: {
    workflowId: NovuWorkflowId;
    recipients: string[];
    payload: NovuPayload;
    dedupeKey: string;
    entityRef?: string;
    notBefore?: Date;
  },
): Promise<StagedTrigger | null> {
  if (args.recipients.length === 0) return null;
  const policy = await resolveRecipientBellPolicy(
    args.workflowId,
    args.recipients,
    { tx },
  );
  if (policy.allowedRecipients.length === 0) return null;
  return stageTrigger({
    tx,
    ...args,
    recipients: policy.allowedRecipients,
    kind: policy.allowedRecipients.length > 1 ? "MULTI" : "SINGLE",
  });
}
