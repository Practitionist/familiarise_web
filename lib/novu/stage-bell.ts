import type { Tx } from "@/lib/prisma";
import { stageTrigger, type NovuPayload, type StagedTrigger } from "./outbox";
import { resolveRecipientBellPolicy } from "./policy";
import type { NovuWorkflowId } from "./templates/types";

export type StageBellTx = Pick<Tx, "notificationOutbox" | "user">;

/**
 * Stage an in-app bell inside the caller's transaction after enforcing
 * recipient workspace routing, channel/category preferences, and quiet hours.
 */
export async function stageBells(
  tx: StageBellTx,
  args: {
    workflowId: NovuWorkflowId;
    recipients: string[];
    payload: NovuPayload;
    dedupeKey?: string;
    entityRef?: string;
    deferrable?: boolean;
    notBefore?: Date;
  },
): Promise<StagedTrigger[]> {
  if (args.recipients.length === 0) return [];
  const policy = await resolveRecipientBellPolicy(
    args.workflowId,
    args.recipients,
    { tx, deferrable: args.deferrable },
  );
  const rows: StagedTrigger[] = [];
  for (const delivery of policy.deliveries) {
    const notBefore =
      args.notBefore && delivery.notBefore
        ? new Date(
            Math.max(args.notBefore.getTime(), delivery.notBefore.getTime()),
          )
        : (args.notBefore ?? delivery.notBefore);
    const row = await stageTrigger({
      ...args,
      tx,
      recipients: [delivery.recipient],
      ...(notBefore ? { notBefore } : {}),
      kind: "SINGLE",
    });
    if (!row) throw new Error("Unable to stage a recipient notification");
    rows.push(row);
  }
  return rows;
}
