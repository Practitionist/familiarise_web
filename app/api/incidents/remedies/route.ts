import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireApiAuth } from "@/lib/auth-helpers";
import { readOpenIncidentRemedies } from "@/lib/booking/incident-rebook";

const QuerySchema = z.object({
  appointmentId: z.string().min(1).max(64).optional(),
});

/** GET — the caller's outage-voided 1:1s still open to a free rebook. */
export async function GET(request: NextRequest) {
  const auth = await requireApiAuth();
  if (auth.error) return auth.error;
  const parsed = QuerySchema.safeParse({
    appointmentId:
      request.nextUrl.searchParams.get("appointmentId") ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  const remedies = await readOpenIncidentRemedies(
    auth.session.user.id,
    parsed.data.appointmentId,
  );
  return NextResponse.json(
    { remedies },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
