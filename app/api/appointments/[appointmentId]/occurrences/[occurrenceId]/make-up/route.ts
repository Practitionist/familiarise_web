import { NextResponse } from "next/server";
import { z } from "zod";

import { scheduleClassMakeUp } from "@/lib/booking/class-sessions";
import { classSessionRoute } from "@/lib/booking/class-session-route";

const MakeUpBodySchema = z.object({ startsAt: z.string().datetime() });

/**
 * POST { startsAt } — #1780 row 4: the host schedules the make-up of a
 * cancelled session (same ordinal), held within 14 days of the cancellation.
 */
export async function POST(
  request: Request,
  {
    params,
  }: { params: Promise<{ appointmentId: string; occurrenceId: string }> },
) {
  return classSessionRoute(
    params,
    { hostOnly: true, op: "class-session-make-up" },
    async ({ occurrenceId }, hosted) => {
      const body = MakeUpBodySchema.safeParse(
        await request.json().catch(() => null),
      );
      if (!body.success) {
        return NextResponse.json(
          { error: "A make-up needs a start time (ISO 8601)." },
          { status: 400 },
        );
      }
      return NextResponse.json(
        await scheduleClassMakeUp(
          hosted,
          occurrenceId,
          new Date(body.data.startsAt),
        ),
      );
    },
  );
}
