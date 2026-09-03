/**
 * Admin TDS return CSV — the authenticated hop to the quarterly full-PAN file.
 *
 * #1354/#1362 — the export job writes one CSV per FY+quarter into the PRIVATE
 * `org-invoices` bucket because it is the only artifact in the system that
 * carries a decrypted PAN. That is also why there is no download proxy and no
 * artifact upload anywhere: a full PAN leaves the database exactly once, into
 * an object no anonymous URL reaches, and this route is the only door — an
 * ADMIN/STAFF session exchanges the quarter for a short-lived signed URL.
 */

import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import { requirePrivilegedAuth } from "@/lib/auth-helpers";
import { applyRateLimit, moneyOpsLimiter } from "@/lib/rate-limit";
import { tdsReturnCsvStoragePath } from "@/lib/compliance/tds-return";
import {
  createPrivateFinanceSignedUrl,
  privateFinanceObjectExists,
} from "@/lib/pdf/storage";

/** Short enough that a leaked URL from a browser history is already dead. */
const SIGNED_URL_TTL_SECONDS = 10 * 60;

/**
 * GET /api/admin/compliance/tds-return?financialYear=2026-27&quarter=2
 * Redirects to a signed URL for that quarter's return CSV.
 */
export async function GET(req: NextRequest) {
  try {
    const auth = await requirePrivilegedAuth();
    if (auth.error) return auth.error;

    const limited = await applyRateLimit(moneyOpsLimiter, auth.session.user.id);
    if (limited) return limited;

    const { searchParams } = new URL(req.url);
    const financialYear = searchParams.get("financialYear") ?? "";
    const quarter = Number.parseInt(searchParams.get("quarter") ?? "", 10);

    if (!/^\d{4}-\d{2}$/.test(financialYear)) {
      return NextResponse.json(
        { error: 'financialYear must look like "2026-27"' },
        { status: 400 },
      );
    }
    if (!Number.isInteger(quarter) || quarter < 1 || quarter > 4) {
      return NextResponse.json(
        { error: "quarter must be 1-4" },
        { status: 400 },
      );
    }

    const storagePath = tdsReturnCsvStoragePath(financialYear, quarter);
    if (!(await privateFinanceObjectExists(storagePath))) {
      return NextResponse.json(
        {
          error:
            "No return CSV for that quarter — run the tds-return-draft workflow first.",
        },
        { status: 404 },
      );
    }

    const signedUrl = await createPrivateFinanceSignedUrl(
      storagePath,
      SIGNED_URL_TTL_SECONDS,
    );
    return NextResponse.redirect(signedUrl, 302);
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "admin" } },
    );
    console.error("Error signing TDS return CSV:", error);
    return NextResponse.json(
      { error: "Failed to fetch the TDS return CSV" },
      { status: 500 },
    );
  }
}
