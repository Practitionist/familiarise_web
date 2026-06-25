/**
 * POST /api/newsletter/subscribe
 *
 * Saves subscriber email to the Newsletter table.
 * Handles re-subscribing (clears unsubscribed flag).
 * No ConvertKit sync yet — TODO when implementing Issue #334.
 */

import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { z } from "zod";
import { syncToConvertKit } from "@/lib/newsletter/convertkit";

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
      update: { unsubscribed: false, unsubscribedAt: null },
    });

    // Stub: ConvertKit sync (Issue #334)
    await syncToConvertKit(email);

    return NextResponse.json({ success: true });
  } catch (error) {
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "newsletter" } });
    console.error("[newsletter/subscribe] Error:", error);
    return NextResponse.json(
      { error: "Failed to subscribe. Please try again." },
      { status: 500 },
    );
  }
}
