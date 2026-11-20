import { NextResponse } from "next/server";
import { z } from "zod";

import prisma from "@/lib/prisma";
import { requireApiAuth } from "@/lib/auth-helpers";
import { readSeatTrails } from "@/lib/booking/seat-history";
import { reportSentryError } from "@/lib/observability/report";
import { SeatTrailResponseSchema } from "@/schemas/seat-removal-lift";

const Params = z.object({ appointmentId: z.string().uuid() });

/** GET — the caller's own seat history on this event; empty when they hold no seat here. */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ appointmentId: string }> },
) {
  const auth = await requireApiAuth();
  if (auth.error) return auth.error;
  const parsed = Params.safeParse(await params);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid appointment id", code: "INVALID_PARAMS" },
      { status: 400 },
    );
  }
  try {
    const seat = await prisma.appointmentParticipant.findUnique({
      where: {
        appointmentId_userId: {
          appointmentId: parsed.data.appointmentId,
          userId: auth.session.user.id,
        },
      },
      select: { id: true, role: true },
    });
    const trails =
      seat?.role === "CONSULTEE"
        ? await readSeatTrails(prisma, [seat.id])
        : new Map();
    return NextResponse.json(
      SeatTrailResponseSchema.parse({
        steps: seat ? (trails.get(seat.id) ?? []) : [],
      }),
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    reportSentryError(error, {
      subsystem: "bookings",
      op: "appointments.seat-trail",
      expected: false,
    });
    return NextResponse.json(
      { error: "Failed to load your seat history" },
      { status: 500 },
    );
  }
}
