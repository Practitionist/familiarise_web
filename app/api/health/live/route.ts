import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** Liveness: the process answers. No dependency is checked, so a container is never restarted for a database outage. */
export function GET() {
  return NextResponse.json(
    { status: "ok" },
    { headers: { "Cache-Control": "no-store" } },
  );
}
