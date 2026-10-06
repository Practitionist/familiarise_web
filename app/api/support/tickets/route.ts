import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import prisma from "@/lib/prisma";
import { createSupportTicket } from "@/lib/support/create-ticket";
import { CreateSupportTicketSchema } from "@/schemas/support";
import { spamLimiter, applyRateLimit } from "@/lib/rate-limit";
import { getSession } from "@/lib/auth-server";
import { assertBodySize } from "@/lib/validation/limits";
import { supportError } from "@/lib/api/support-http";
import {
  GET as getUserSupportTickets,
  POST as postUserSupportTicket,
} from "@/app/api/user/support-tickets/route";

const TICKETS_ROUTE = "support.tickets";

const OutboundSupportTicketSchema = CreateSupportTicketSchema.extend({
  targetUserId: z.string().trim().min(1).max(200),
});

export const GET = getUserSupportTickets;

async function resolveTargetUserId(
  targetLookup: string,
): Promise<string | null> {
  const targetUser = targetLookup.includes("@")
    ? await prisma.user.findFirst({
        where: { email: { equals: targetLookup, mode: "insensitive" } },
        select: { id: true },
      })
    : await prisma.user.findUnique({
        where: { id: targetLookup },
        select: { id: true },
      });
  return targetUser?.id ?? null;
}

export async function POST(req: NextRequest) {
  try {
    const tooLarge = assertBodySize(req);
    if (tooLarge) return tooLarge;

    let body: unknown;
    try {
      body = await req.clone().json();
    } catch {
      return NextResponse.json(
        { error: "Invalid JSON body", code: "VALIDATION_FAILED" },
        { status: 400 },
      );
    }

    const hasTargetUserId =
      typeof body === "object" &&
      body !== null &&
      "targetUserId" in body &&
      Boolean((body as { targetUserId?: unknown }).targetUserId);

    if (!hasTargetUserId) {
      return postUserSupportTicket(req);
    }

    const session = await getSession(true);
    if (!session?.user?.id) {
      return supportError({ status: 401, code: "UNAUTHORIZED" });
    }

    const rl = await applyRateLimit(spamLimiter, `tickets:${session.user.id}`);
    if (rl) return rl;

    const isOperator =
      session.user.role === "ADMIN" || session.user.role === "STAFF";
    if (!isOperator) {
      return supportError({
        status: 403,
        code: "FORBIDDEN",
        message: "Only staff or admin operators can open outbound tickets.",
        context: { route: TICKETS_ROUTE, action: "create" },
      });
    }

    const result = OutboundSupportTicketSchema.safeParse(body);
    if (!result.success) {
      return supportError({
        status: 400,
        code: "VALIDATION_FAILED",
        detail: result.error.flatten(),
        context: { route: TICKETS_ROUTE, action: "create" },
      });
    }
    const validatedData = result.data;

    const ticketUserId = await resolveTargetUserId(validatedData.targetUserId);
    if (!ticketUserId) {
      return supportError({
        status: 404,
        code: "NOT_FOUND",
        message: "Target user not found.",
        context: { route: TICKETS_ROUTE, action: "create" },
      });
    }

    const ticket = await createSupportTicket({
      userId: ticketUserId,
      title: validatedData.title,
      description: validatedData.description,
      priority: validatedData.priority || "MEDIUM",
      category: validatedData.category,
      issueType: validatedData.issueType ?? "GENERAL_INQUIRY",
      organizationId: validatedData.organizationId ?? null,
      consultationId: validatedData.consultationId,
      subscriptionId: validatedData.subscriptionId,
      paymentId: validatedData.paymentId,
    });

    return NextResponse.json(ticket, { status: 201 });
  } catch (cause) {
    return supportError({
      status: 500,
      code: "INTERNAL",
      cause,
      context: { route: TICKETS_ROUTE, action: "create" },
    });
  }
}
