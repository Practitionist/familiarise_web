import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdminAuth } from "@/lib/auth-helpers";
import { supportError } from "@/lib/api/support-http";
import { supportMonthlyComplianceReport } from "@/lib/support/case-service";

const IST_OFFSET_MS = 330 * 60_000;

function defaultIstYearMonth(): { year: number; month: number } {
  const istNow = new Date(Date.now() + IST_OFFSET_MS);
  return {
    year: istNow.getUTCFullYear(),
    month: istNow.getUTCMonth() + 1,
  };
}

const QuerySchema = z.object({
  year: z.coerce.number().int().min(2020).max(2100),
  month: z.coerce.number().int().min(1).max(12),
});

export async function GET(req: NextRequest) {
  try {
    const auth = await requireAdminAuth();
    if (auth.error) return auth.error;

    const defaults = defaultIstYearMonth();
    const parsed = QuerySchema.safeParse({
      year: req.nextUrl.searchParams.get("year") ?? defaults.year,
      month: req.nextUrl.searchParams.get("month") ?? defaults.month,
    });
    if (!parsed.success) {
      return supportError({
        status: 400,
        code: "VALIDATION_FAILED",
        detail: parsed.error.flatten(),
        context: { route: "admin.support.compliance-report", action: "get" },
      });
    }

    const report = await supportMonthlyComplianceReport(
      parsed.data.year,
      parsed.data.month,
    );

    return NextResponse.json({ data: report });
  } catch (cause) {
    return supportError({
      status: 500,
      code: "INTERNAL",
      cause,
      context: { route: "admin.support.compliance-report", action: "get" },
    });
  }
}
