import type { SupportCaseStatus } from "@prisma/client";
import prisma from "../../lib/prisma";
import { allocateTicketReference } from "../../lib/support/reference";
import { slaDeadlinesFor } from "../../lib/support/sla";
import { supportDeadline } from "../../lib/support/deadline-policy";
import type { UserWithProfiles } from "./1a-create-users";

/** Seed canonical correspondence directly, without historical ticket/thread tables. */
export async function createSupportCases(
  users: UserWithProfiles[],
): Promise<void> {
  const customers = users
    .filter((user) => user.role === "CONSULTEE" || user.role === "CONSULTANT")
    .slice(0, 25);
  const operator = users.find(
    (user) => user.role === "STAFF" || user.role === "ADMIN",
  );
  if (!operator) return;
  const statuses: SupportCaseStatus[] = [
    "OPEN",
    "IN_PROGRESS",
    "ESCALATED",
    "RESOLVED",
    "CLOSED",
  ];
  // Allocate references sequentially without opening competing seed transactions.
  for (const [index, customer] of customers.entries()) {
    const status = statuses[index % statuses.length];
    const createdAt = new Date(Date.now() - 2 * 86_400_000);
    const repliedAt = new Date(createdAt.getTime() + 3_600_000);
    const hasReply = status !== "OPEN";
    const settled = status === "RESOLVED" || status === "CLOSED";
    await prisma.$transaction(async (tx) => {
      const referenceNumber = await allocateTicketReference(tx, createdAt);
      await tx.supportCase.create({
        data: {
          referenceNumber,
          requesterUserId: customer.id,
          submitterUserId: customer.id,
          title: "Help with my account",
          description: "I need help updating my account settings.",
          category: "ACCOUNT",
          scopeKey: "ACCOUNT",
          ownershipScope: "PERSONAL",
          status,
          priority: "MEDIUM",
          activeChannel: "HUMAN",
          assignedToId: hasReply ? operator.id : null,
          createdAt,
          updatedAt: hasReply ? repliedAt : createdAt,
          receivedAt: createdAt,
          ...slaDeadlinesFor("MEDIUM", createdAt),
          ...supportDeadline("ACCOUNT", createdAt),
          acknowledgedAt: hasReply ? repliedAt : null,
          firstAgentReplyAt: hasReply ? repliedAt : null,
          resolvedAt: settled ? repliedAt : null,
          closedAt: status === "CLOSED" ? repliedAt : null,
          messageSeq: hasReply ? 2 : 1,
          lastMessageAt: hasReply ? repliedAt : createdAt,
          subjects: {
            create: {
              subjectType: "ACCOUNT",
              subjectId: customer.id,
              isPrimary: true,
            },
          },
          messages: {
            create: [
              {
                seq: 1,
                sender: "USER",
                authorUserId: customer.id,
                body: "I need help updating my account settings.",
                createdAt,
              },
              ...(hasReply
                ? [
                    {
                      seq: 2,
                      sender: "AGENT" as const,
                      authorUserId: operator.id,
                      body: settled
                        ? "Your account settings have been updated. Please let us know if you need more help."
                        : "We are reviewing your account settings and will update you here.",
                      createdAt: repliedAt,
                    },
                  ]
                : []),
            ],
          },
          events: {
            create: { kind: "CREATED", actorId: customer.id, createdAt },
          },
        },
      });
    });
  }
  console.log(`Created ${customers.length} canonical support cases`);
}
