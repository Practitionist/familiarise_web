/**
 * POST /api/newsletter/subscribe
 *
 * Saves subscriber email to the Newsletter table.
 * No ConvertKit sync yet — TODO when implementing Issue #334.
 */

import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { z } from "zod";

const subscribeSchema = z.object({
  email: z.string().email("Invalid email address"),
});

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const body = await req.json();
    const parsed = subscribeSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid email address" },
        { status: 400 },
      );
    }

    const { email } = parsed.data;

    await prisma.newsletter.upsert({
      where: { email },
      create: { email },
      update: {}, // already subscribed — no-op
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("[newsletter/subscribe] Error:", error);
    return NextResponse.json(
      { error: "Failed to subscribe. Please try again." },
      { status: 500 },
    );
  }
}
