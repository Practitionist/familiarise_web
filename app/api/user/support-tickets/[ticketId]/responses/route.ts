import { NextRequest, NextResponse } from "next/server";
import prisma from "lib/prisma";
import { getSession } from "@/lib/auth-server";
import { spamLimiter, applyRateLimit } from "@/lib/rate-limit";
import { assertBodySize } from "@/lib/validation/limits";
import { CreateSupportResponseSchema } from "@/schemas/support";
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ ticketId: string }> },
) {
  try {
    const [session, resolvedParams] = await Promise.all([getSession(), params]);

    if (!session?.user?.id) {
      return NextResponse.json(
        { error: "You must be logged in to respond to support tickets" },
        { status: 401 },
      );
    }

    // #831 — raw body.message was unbounded and unlimited
    const rl = await applyRateLimit(
      spamLimiter,
      `ticket-response:${session.user.id}`,
    );
    if (rl) return rl;
    const tooLarge = assertBodySize(req);
    if (tooLarge) return tooLarge;

    const { ticketId } = resolvedParams;
    const parsed = CreateSupportResponseSchema.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Validation failed", details: parsed.error.issues },
        { status: 400 },
      );
    }
    const body = parsed.data;

    // Verify the ticket exists and belongs to the user
    const ticket = await prisma.supportTicket.findFirst({
      where: {
        id: ticketId,
        userId: session.user.id,
      },
    });

    if (!ticket) {
      return NextResponse.json(
        {
          error:
            "This support ticket does not exist or you don't have permission to access it",
        },
        { status: 404 },
      );
    }

    const response = await prisma.supportResponse.create({
      data: {
        message: body.message,
        supportTicket: { connect: { id: ticketId } },
        user: { connect: { id: session.user.id } },
      },
      include: {
        user: {
          select: {
            name: true,
            role: true,
          },
        },
      },
    });

    // Update ticket status to IN_PROGRESS if it was OPEN
    if (ticket.status === "OPEN") {
      await prisma.supportTicket.update({
        where: { id: ticketId },
        data: { status: "IN_PROGRESS" },
      });
    }

    return NextResponse.json(response, { status: 201 });
  } catch (error) {
    console.error("Error creating support response:", error);
    return NextResponse.json(
      {
        error: "An unexpected error occurred while submitting your response",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
