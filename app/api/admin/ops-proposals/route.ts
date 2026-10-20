import { OpsActionProposalStatus } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireBackofficeSurface } from "@/lib/auth-helpers";
import { listProposals } from "@/lib/backoffice/ops-proposals";

const QuerySchema = z.object({
  status: z.nativeEnum(OpsActionProposalStatus).default("PROPOSED"),
});

/** GET ?status= — second-approval proposals in one effective status (expiry read live). */
export async function GET(req: NextRequest) {
  const auth = await requireBackofficeSurface("payments.manage");
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
  const proposals = await listProposals(parsed.data.status, new Date());
  return NextResponse.json(
    { proposals },
    { headers: { "Cache-Control": "no-store" } },
  );
}
