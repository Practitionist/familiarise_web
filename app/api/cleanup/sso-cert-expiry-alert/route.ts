/**
 * POST /api/cleanup/sso-cert-expiry-alert
 *
 * HTTP companion to `jobs/cleanup/sso-cert-expiry-alert.ts`. Lets an
 * operator run the scan on-demand after rotating a cert or onboarding
 * a new SAML provider — useful for confirming the alert path without
 * waiting for the 03:00 UTC slot.
 *
 * Auth: `CRON_SECRET` bearer.
 */

import { NextResponse, type NextRequest } from "next/server";
import { runSsoCertExpiryAlert } from "@/scripts/cleanup/sso-cert-expiry-alert";

export async function POST(req: NextRequest): Promise<NextResponse> {
  const authHeader = req.headers.get("authorization");
  const cronSecret =
    process.env.CRON_SECRET || process.env.VERCEL_CRON_SECRET;

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    console.warn("Unauthorized sso-cert-expiry-alert attempt");
    return NextResponse.json(
      {
        error: "Unauthorized",
        message:
          "Please provide a valid authorization header with the CRON_SECRET",
      },
      { status: 401 },
    );
  }

  try {
    const result = await runSsoCertExpiryAlert();

    console.log("✅ SSO cert expiry alert completed:", {
      scanned: result.scanned,
      alerted: result.alerted,
      success: result.success,
    });

    return NextResponse.json(result, { status: result.success ? 200 : 500 });
  } catch (error) {
    console.error("[cleanup/sso-cert-expiry-alert] failed:", error);
    return NextResponse.json(
      {
        error: "Alert scan failed",
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    );
  }
}

// Some external schedulers (e.g. legacy Vercel Cron) only emit GET.
export async function GET(req: NextRequest): Promise<NextResponse> {
  return POST(req);
}
