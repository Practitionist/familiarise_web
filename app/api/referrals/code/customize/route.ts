import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSession } from "@/lib/auth-server";
import { applyRateLimit, referralCustomizeLimiter } from "@/lib/rate-limit";
import { setCustomCode } from "@/lib/referrals/service";

const customizeBodySchema = z.object({
  customCode: z.string().trim().min(1).max(64),
});

export async function POST(req: NextRequest) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const rl = await applyRateLimit(referralCustomizeLimiter, session.user.id);
    if (rl) return rl;

    const body = customizeBodySchema.safeParse(
      await req.json().catch(() => null),
    );
    if (!body.success) {
      return NextResponse.json(
        { error: "customCode is required" },
        { status: 400 },
      );
    }

    const result = await setCustomCode(session.user.id, body.data.customCode);

    if (!result) {
      return NextResponse.json(
        {
          error:
            "Unable to set custom code. It may be taken, too short (min 3 chars), or too long (max 20 chars).",
        },
        { status: 400 },
      );
    }

    return NextResponse.json({ data: result });
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "referrals" } },
    );
    console.error("Error setting custom code:", error);
    return NextResponse.json(
      { error: "Failed to set custom code" },
      { status: 500 },
    );
  }
}
