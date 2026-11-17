/**
 * Admin download for the monthly GST outward-supplies register — the GSTR-1
 * working file.
 *
 * The export job writes one CSV per IST calendar month into the PRIVATE
 * `org-invoices` bucket at `compliance/gst/<first day>_<last day>.csv`, so
 * without this route the file is only reachable from the Supabase dashboard.
 * This route is the only door: an ADMIN session exchanges a month for a
 * short-lived signed URL.
 *
 * `compliance.manage` is ADMIN-only: the register is the platform's own
 * outward-supply return.
 */

import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireBackofficeSurface } from "@/lib/auth-helpers";
import { applyRateLimit, gstRegisterDownloadLimiter } from "@/lib/rate-limit";
import { gstOutwardRegisterCsvStoragePath } from "@/lib/compliance/gst-outward-register";
import {
  nextMonthStart,
  previousIstCalendarMonthStart,
} from "@/lib/compliance/ist-period";
import {
  createPrivateFinanceSignedUrl,
  privateFinanceObjectExists,
} from "@/lib/storage/private-finance-object";

/** Short enough that a leaked URL from a browser history is already dead. */
const SIGNED_URL_TTL_SECONDS = 10 * 60;

/**
 * The canonical period: one IST calendar month, `YYYY-MM`. A month that is
 * not a real one is refused rather than read as some other period.
 */
const QuerySchema = z.object({
  period: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'period must look like "2026-10"'),
});

/**
 * The window the export job used for that month: the month itself, from its
 * first IST midnight to the first IST midnight of the month after.
 *
 * `previousIstCalendarMonthStart` names the previous IST calendar month of
 * the instant it is given, so it is given an anchor inside the month AFTER
 * the one asked for, and `nextMonthStart` closes the window. They are the
 * helpers the job itself uses, so the storage path built from them is the
 * path the job uploaded to.
 */
function istCalendarMonthWindow(period: string): {
  periodStart: Date;
  periodEnd: Date;
} {
  const [yearText, monthText] = period.split("-");
  const year = Number.parseInt(yearText, 10);
  const month = Number.parseInt(monthText, 10);

  // The anchor is the UTC midnight of the first day of the FOLLOWING month,
  // which is 05:30 IST on that day and so unambiguously inside the IST month
  // whose start is wanted. `setUTCFullYear` takes a zero-based month, so the
  // one-based month of the period lands on the month after it.
  const anchor = new Date(0);
  anchor.setUTCFullYear(year, month, 1);

  const periodStart = previousIstCalendarMonthStart(anchor);
  return { periodStart, periodEnd: nextMonthStart(periodStart) };
}

/**
 * Every answer here depends on the caller's session, so none of them is
 * stored: the redirect in particular points at a URL that expires.
 */
const NO_STORE = { "Cache-Control": "private, no-store" } as const;

/**
 * GET /api/admin/compliance/gst-register?period=2026-10
 * Redirects to a signed URL for that month's outward-supplies register.
 */
export async function GET(req: NextRequest) {
  try {
    const auth = await requireBackofficeSurface("compliance.manage");
    if (auth.error) return auth.error;

    const limited = await applyRateLimit(
      gstRegisterDownloadLimiter,
      auth.session.user.id,
    );
    if (limited) return limited;

    const { searchParams } = new URL(req.url);
    const parsed = QuerySchema.safeParse(Object.fromEntries(searchParams));
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid query", detail: parsed.error.flatten() },
        { status: 400, headers: NO_STORE },
      );
    }

    const { periodStart, periodEnd } = istCalendarMonthWindow(
      parsed.data.period,
    );
    const storagePath = gstOutwardRegisterCsvStoragePath(
      periodStart,
      periodEnd,
    );
    if (!(await privateFinanceObjectExists(storagePath))) {
      return NextResponse.json(
        {
          error:
            "No outward-supplies register for that period — run the gst-outward-register-export job first.",
        },
        { status: 404, headers: NO_STORE },
      );
    }

    const signedUrl = await createPrivateFinanceSignedUrl(
      storagePath,
      SIGNED_URL_TTL_SECONDS,
    );
    return NextResponse.redirect(signedUrl, {
      status: 302,
      headers: NO_STORE,
    });
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "admin" } },
    );
    console.error("Error signing the GST outward-supplies register:", error);
    return NextResponse.json(
      { error: "Failed to fetch the GST outward-supplies register" },
      { status: 500, headers: NO_STORE },
    );
  }
}
