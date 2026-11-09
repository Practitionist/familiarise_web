import type { Tx } from "@/lib/prisma";
import { stagePages, type NovuPayload, type StagedTrigger } from "./outbox";
import type { NovuWorkflowId } from "./templates/types";
import { notificationScope } from "./workflows";

/** A bell recipient and the organisation their bell belongs to (null = personal). */
export interface ScopedRecipient {
  userId: string;
  organizationId: string | null;
}

/**
 * Stages one set of pages per notification scope, so each recipient's bell
 * carries their own scope; the inbox tabs filter on it.
 */
export async function stageScopedPages(
  tx: Pick<Tx, "notificationOutbox">,
  args: {
    workflowId: NovuWorkflowId;
    recipients: readonly ScopedRecipient[];
    payload: NovuPayload;
    dedupeKey: string;
    entityRef: string;
  },
): Promise<StagedTrigger[]> {
  const byScope = new Map<string | null, string[]>();
  for (const r of args.recipients) {
    const ids = byScope.get(r.organizationId) ?? [];
    if (!ids.includes(r.userId)) ids.push(r.userId);
    byScope.set(r.organizationId, ids);
  }
  const staged: StagedTrigger[] = [];
  for (const [organizationId, recipients] of byScope) {
    staged.push(
      ...(await stagePages(tx, {
        workflowId: args.workflowId,
        recipients,
        payload: { ...args.payload, ...notificationScope(organizationId) },
        dedupeKey: `${args.dedupeKey}:${organizationId ? `org:${organizationId}` : "personal"}`,
        entityRef: args.entityRef,
      })),
    );
  }
  return staged;
}
