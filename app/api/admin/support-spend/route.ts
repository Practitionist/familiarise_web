import { NextResponse, type NextRequest } from "next/server";
import { pageNumberSchema } from "@/lib/backoffice/list-paging";

import { requireBackofficeSurface } from "@/lib/auth-helpers";
import { readSupportSpend } from "@/lib/backoffice/support-spend";

/** The Support spend tab's API twin: staff read their own row, admins every operator. */
export async function GET(req: NextRequest) {
  const auth = await requireBackofficeSurface("opsLog.read");
  if (auth.error) return auth.error;
  const report = await readSupportSpend({
    viewer: {
      userId: auth.session.user.id,
      role: String(auth.session.user.role ?? ""),
    },
    now: new Date(),
    page: pageNumberSchema.parse(
      req.nextUrl.searchParams.get("page") ?? undefined,
    ),
  });
  return NextResponse.json(report, {
    headers: { "Cache-Control": "no-store" },
  });
}
