import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireBackofficeSurface } from "@/lib/auth-helpers";
import { CreateSupportTicketSchema } from "@/schemas/support";
import { assertBodySize } from "@/lib/validation/limits";
import { supportError } from "@/lib/api/support-http";
import { createOutboundStaffSupportTicket } from "@/lib/support/create-ticket";
import {
  GET as getUserSupportTickets,
  POST as postUserSupportTicket,
} from "@/app/api/user/support-tickets/route";

const STAFF_OUTBOUND_ROUTE = "staff.support-tickets";

const OutboundSupportTicketSchema = CreateSupportTicketSchema.extend({
  targetUserId: z.string().trim().min(1).max(200),
});

export const GET = getUserSupportTickets;

export async function POST(req: NextRequest) {
  const cloned = req.clone();
  const peek = (await cloned.json().catch(() => null)) as {
    targetUserId?: unknown;
  } | null;

  if (!peek || typeof peek.targetUserId !== "string") {
    return postUserSupportTicket(req);
  }

  try {
    const auth = await requireBackofficeSurface("tickets.manage");
    if (auth.error) return auth.error;
    const { session } = auth;

    const tooLarge = assertBodySize(req);
    if (tooLarge) return tooLarge;

    const result = OutboundSupportTicketSchema.safeParse(peek);
    if (!result.success) {
      return supportError({
        status: 400,
        code: "VALIDATION_FAILED",
        detail: result.error.flatten(),
        context: { route: STAFF_OUTBOUND_ROUTE, action: "create" },
      });
    }
    const validatedData = result.data;

    const ticket = await createOutboundStaffSupportTicket({
      staffUserId: session.user.id,
      staffUserName: session.user.name,
      targetLookup: validatedData.targetUserId,
      title: validatedData.title,
      description: validatedData.description,
      priority: validatedData.priority,
      category: validatedData.category,
      issueType: validatedData.issueType,
      organizationId: validatedData.organizationId,
      paymentId: validatedData.paymentId,
    });

    if (!ticket) {
      return NextResponse.json(
        {
          error: "Target user not found.",
          code: "NOT_FOUND",
        },
        { status: 404 },
      );
    }

    return NextResponse.json(ticket, { status: 201 });
  } catch (cause) {
    return supportError({
      status: 500,
      code: "INTERNAL",
      cause,
      context: { route: STAFF_OUTBOUND_ROUTE, action: "create" },
    });
  }
}
