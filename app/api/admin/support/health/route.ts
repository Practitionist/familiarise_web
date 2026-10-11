import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdminAuth } from "@/lib/auth-helpers";
import { supportError } from "@/lib/api/support-http";
import { supportHealthMetrics } from "@/lib/support/deflection";

const QuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(365).default(30),
});

export async function GET(req: NextRequest) {
  try {
    const auth = await requireAdminAuth();
    if (auth.error) return auth.error;

    const parsed = QuerySchema.safeParse({
      days: req.nextUrl.searchParams.get("days") ?? undefined,
    });
    if (!parsed.success) {
      return supportError({
        status: 400,
        code: "VALIDATION_FAILED",
        detail: parsed.error.flatten(),
        context: { route: "admin.support.health", action: "get" },
      });
    }

    const since = new Date(Date.now() - parsed.data.days * 86_400_000);
    const metrics = await supportHealthMetrics(since);

    return NextResponse.json({
      data: {
        since: since.toISOString(),
        days: parsed.data.days,
        ...metrics,
      },
    });
  } catch (cause) {
    return supportError({
      status: 500,
      code: "INTERNAL",
      cause,
      context: { route: "admin.support.health", action: "get" },
    });
  }
}
