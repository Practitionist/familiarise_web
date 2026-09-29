import { NextResponse } from "next/server";

import { skipClassMakeUp } from "@/lib/booking/class-sessions";
import { classSessionRoute } from "@/lib/booking/class-session-route";

/**
 * POST — #1780 decision 5 (E-3b): a seat holder who cannot make the make-up
 * of a cancelled session takes that one session back now, under the same
 * refund key the day-14 sweep uses.
 */
export async function POST(
  _request: Request,
  {
    params,
  }: { params: Promise<{ appointmentId: string; occurrenceId: string }> },
) {
  return classSessionRoute(
    params,
    { hostOnly: false, op: "class-session-skip-make-up" },
    async ({ actor, appointmentId, occurrenceId }) =>
      NextResponse.json(
        await skipClassMakeUp({
          appointmentId,
          sourceOccurrenceId: occurrenceId,
          userId: actor.userId,
        }),
      ),
  );
}
