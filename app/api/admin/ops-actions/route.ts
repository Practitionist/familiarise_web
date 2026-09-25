import { NextRequest, NextResponse } from "next/server";

import { requireBackofficeSurface } from "@/lib/auth-helpers";
import { opsLogFiltersFrom, readOpsLog } from "@/lib/backoffice/ops-log-read";

/** #1771 K-9 — the Audit tab's API twin: one page of OpsActionLog. */
export async function GET(req: NextRequest) {
  const auth = await requireBackofficeSurface("opsLog.read");
  if (auth.error) return auth.error;
  const sp = req.nextUrl.searchParams;
  const page = await readOpsLog({
    viewer: {
      userId: auth.session.user.id,
      role: String(auth.session.user.role ?? ""),
    },
    filters: opsLogFiltersFrom((k) => sp.get(k)),
    page: Number(sp.get("page") ?? "1"),
  });
  return NextResponse.json(page, {
    headers: { "Cache-Control": "no-store" },
  });
}
