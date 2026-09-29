import { NextResponse } from "next/server";

import { cancelClassSession } from "@/lib/booking/class-sessions";
import { classSessionRoute } from "@/lib/booking/class-session-route";

/**
 * POST — #1780 row 4: the class host cancels ONE future session. It stays
 * countable (no deletedAt); seat holders are told the make-up deadline.
 */
export async function POST(
  _request: Request,
  {
    params,
  }: { params: Promise<{ appointmentId: string; occurrenceId: string }> },
) {
  return classSessionRoute(
    params,
    { hostOnly: true, op: "class-session-cancel" },
    async ({ occurrenceId }, hosted) => {
      return NextResponse.json(await cancelClassSession(hosted, occurrenceId));
    },
  );
}
