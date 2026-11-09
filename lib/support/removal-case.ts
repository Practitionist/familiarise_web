/**
 * The support case a host's conduct removal opens for the removed attendee. The
 * attendee is the requester: the case is their route to contest the removal, and
 * its payout hold keeps the host from keeping the seat's money unreviewed.
 */

import type { SupportCase } from "@prisma/client";

import type { Tx } from "@/lib/prisma";
import { stageSupportCaseIntakeTx } from "@/lib/support/case-service";
import { supportDeadline } from "@/lib/support/deadline-policy";
import { priorityForReason } from "@/lib/support/priority";
import { allocateTicketReference } from "@/lib/support/reference";
import { slaDeadlinesFor } from "@/lib/support/sla";

export const REMOVAL_CASE_CATEGORY = "CONDUCT_REMOVAL" as const;
export const REMOVAL_CASE_TITLE = "Removed from a group session";

export interface OpenRemovalCaseInput {
  appointmentId: string;
  removedUserId: string;
  actorUserId: string;
  eventTitle: string | null;
  reasonLabel: string;
  note: string | null;
}

/** The removed attendee's own words are theirs to add; this is only what the host recorded. */
export function removalCaseBody(input: {
  eventTitle: string | null;
  reasonLabel: string;
  note: string | null;
}): string {
  const lines = [
    `You were removed from ${input.eventTitle ?? "a group session"} by the host.`,
    `Reason recorded: ${input.reasonLabel}`,
  ];
  if (input.note) lines.push(`Host's note: ${input.note}`);
  lines.push(
    "",
    "Support will review this. Reply here if you want to give your side. If the removal is not upheld, your payment is refunded in full.",
  );
  return lines.join("\n");
}

/**
 * Opens the case on `tx`, or returns the attendee's open removal case on this
 * booking so a repeat removal never stacks a second case.
 */
export async function openRemovalCaseTx(
  tx: Tx,
  input: OpenRemovalCaseInput,
  now: Date = new Date(),
): Promise<Pick<SupportCase, "id" | "referenceNumber">> {
  const scope = {
    ownershipScope: "PERSONAL" as const,
    organizationId: null,
    scopeKey: `APPOINTMENT:${input.appointmentId}`,
    requesterUserId: input.removedUserId,
    submitterUserId: input.removedUserId,
    category: REMOVAL_CASE_CATEGORY,
  };
  const open = await tx.supportCase.findFirst({
    where: { ...scope, closedAt: null, deletedAt: null },
    select: { id: true, referenceNumber: true },
  });
  if (open) return open;

  const body = removalCaseBody(input);
  const priority = priorityForReason(null);
  const referenceNumber = await allocateTicketReference(tx, now);
  const created = await tx.supportCase.create({
    data: {
      ...scope,
      referenceNumber,
      appointmentId: input.appointmentId,
      title: REMOVAL_CASE_TITLE,
      description: body,
      activeChannel: "HUMAN",
      priority,
      status: "OPEN",
      receivedAt: now,
      ...supportDeadline(REMOVAL_CASE_CATEGORY, now),
      ...slaDeadlinesFor(priority, now),
      messageSeq: 1,
      lastMessageAt: now,
      subjects: {
        create: [
          {
            subjectType: "APPOINTMENT",
            subjectId: input.appointmentId,
            isPrimary: true,
          },
        ],
      },
      messages: {
        create: [
          {
            seq: 1,
            sender: "SYSTEM",
            body,
            isInternal: false,
            authorUserId: null,
            createdAt: now,
          },
        ],
      },
      events: {
        create: [
          {
            actorId: input.actorUserId,
            kind: "CREATED",
            toValue: "OPEN",
            note: "Opened by a host removing the attendee",
            createdAt: now,
          },
        ],
      },
    },
  });
  // AGENT, not SYSTEM: the attendee must get the bell; SYSTEM notifies staff only.
  await stageSupportCaseIntakeTx(tx, created, "AGENT");
  return { id: created.id, referenceNumber: created.referenceNumber };
}
