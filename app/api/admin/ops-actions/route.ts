import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireBackofficeSurface } from "@/lib/auth-helpers";
import { readOpsLog } from "@/lib/backoffice/ops-log-read";

const filter = z.string().trim().max(200).optional();
const QuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  actorUserId: filter,
  surface: filter,
  targetKind: filter,
  targetId: filter,
});

/** #1771 K-9 — the Audit tab's API twin: one page of OpsActionLog. */
export async function GET(req: NextRequest) {
  const auth = await requireBackofficeSurface("opsLog.read");
  if (auth.error) return auth.error;
  const parsed = QuerySchema.safeParse(
    Object.fromEntries(req.nextUrl.searchParams),
  );
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid query", code: "INVALID_QUERY" },
      { status: 400 },
    );
  }
  const { page, ...filters } = parsed.data;
  const result = await readOpsLog({
    viewer: {
      userId: auth.session.user.id,
      role: String(auth.session.user.role ?? ""),
    },
    filters: {
      actorUserId: filters.actorUserId || undefined,
      surface: filters.surface || undefined,
      targetKind: filters.targetKind || undefined,
      targetId: filters.targetId || undefined,
    },
    page,
  });
  return NextResponse.json(result, {
    headers: { "Cache-Control": "no-store" },
  });
}
