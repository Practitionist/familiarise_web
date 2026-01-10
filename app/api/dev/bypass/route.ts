/**
 * Dev Bypass API - Enable/disable dev mode dashboard bypass
 *
 * DEVELOPMENT ONLY - This endpoint only works in development mode.
 *
 * Usage:
 *   Enable:  GET /api/dev/bypass?enable=true
 *   Disable: GET /api/dev/bypass?enable=false
 *   Status:  GET /api/dev/bypass
 *
 * When enabled, you can access any user's dashboard by navigating directly to:
 *   /dashboard/consultant/[anyConsultantId]/home
 *   /dashboard/consultee/[anyConsulteeId]/home
 *   /dashboard/admin/home
 *   /dashboard/staff/[anyStaffId]/home
 */

import { NextRequest, NextResponse } from "next/server";

const DEV_BYPASS_COOKIE = "dev_bypass";

export async function GET(req: NextRequest) {
  // Only allow in development
  if (process.env.NODE_ENV !== "development") {
    return NextResponse.json(
      { error: "Dev bypass only available in development mode" },
      { status: 403 }
    );
  }

  const { searchParams } = new URL(req.url);
  const enable = searchParams.get("enable");
  const currentValue = req.cookies.get(DEV_BYPASS_COOKIE)?.value === "true";

  // If no enable param, just return current status
  if (enable === null) {
    return NextResponse.json({
      enabled: currentValue,
      message: currentValue
        ? "Dev bypass is ENABLED - you can access any dashboard"
        : "Dev bypass is DISABLED - normal routing in effect",
      usage: {
        enable: "/api/dev/bypass?enable=true",
        disable: "/api/dev/bypass?enable=false",
      },
    });
  }

  // Set or clear the cookie
  const shouldEnable = enable === "true";
  const response = NextResponse.json({
    enabled: shouldEnable,
    message: shouldEnable
      ? "Dev bypass ENABLED - you can now access any dashboard"
      : "Dev bypass DISABLED - normal routing restored",
  });

  if (shouldEnable) {
    response.cookies.set(DEV_BYPASS_COOKIE, "true", {
      path: "/",
      httpOnly: false, // Allow JS access for debugging
      sameSite: "lax",
      maxAge: 60 * 60 * 24, // 24 hours
    });
  } else {
    response.cookies.delete(DEV_BYPASS_COOKIE);
  }

  return response;
}
