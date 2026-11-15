import type { Tx } from "@/lib/prisma";
import { stageTrigger, type NovuPayload, type StagedTrigger } from "./outbox";
import { resolveRecipientBellPolicy } from "./policy";
import type { NovuWorkflowId } from "./templates/types";
import {
  REQUIRED_NOTICE_FIELD,
  type RequiredNoticeKind,
} from "@/lib/notifications/required-notices";

export type StageBellTx = Pick<Tx, "notificationOutbox"> &
  Partial<Pick<Tx, "user">>;

/**
 * Stage an in-app bell inside the caller's transaction after enforcing each
 * recipient's channel and category preferences; `required` skips them for every recipient.
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
    required?: RequiredNoticeKind;
  },
): Promise<StagedTrigger | null> {
  if (args.recipients.length === 0) return null;
  const { required, ...rest } = args;
  const policy = await resolveRecipientBellPolicy(
    args.workflowId,
    args.recipients,
    { tx, required: required !== undefined },
  );
  if (policy.allowedRecipients.length === 0) return null;
  return stageTrigger({
    tx,
    ...rest,
    payload: required
      ? { ...rest.payload, [REQUIRED_NOTICE_FIELD]: required }
      : rest.payload,
    recipients: policy.allowedRecipients,
    kind: policy.allowedRecipients.length > 1 ? "MULTI" : "SINGLE",
  });
}
