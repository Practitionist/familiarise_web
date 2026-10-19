import "server-only";

import prisma from "@/lib/prisma";
import { runSupportTurn } from "@/lib/support/service";

/**
 * Raises a removal request in the learner's support thread for the booking:
 * walks the documents flow to its removal escalation, or adds a message when a
 * person is already handling the thread. Returns the thread id.
 */
export async function raiseDocumentRemovalRequest(args: {
  appointmentId: string;
  userId: string;
  documentName: string;
  note: string | null;
}): Promise<string | null> {
  const message = [
    `Please remove the document "${args.documentName}" from this booking.`,
    args.note ? `Reason: ${args.note}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  const existing = await prisma.supportCase.findFirst({
    where: { appointmentId: args.appointmentId, requesterUserId: args.userId, deletedAt: null },
    orderBy: { createdAt: "desc" },
    select: { activeChannel: true, status: true },
  });
  if (existing?.activeChannel === "HUMAN" && existing.status !== "RESOLVED") {
    const turn = await runSupportTurn(args.appointmentId, args.userId, {
      userMessage: message,
    });
    return turn?.threadId ?? null;
  }

  await runSupportTurn(args.appointmentId, args.userId, {
    category: "DOCUMENTS",
  });
  const turn = await runSupportTurn(args.appointmentId, args.userId, {
    chosenOptionId: "remove",
    userMessage: message,
  });
  return turn?.threadId ?? null;
}
