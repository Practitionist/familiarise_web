/**
 * GET /api/staff/appointments/[appointmentId]/timeline — one booking's audit
 * trail. Gated on `appointments.manage`, which earns the `all` scope; org roles
 * get no per-session drill-in (ADR 20).
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireBackofficeSurface } from "@/lib/auth-helpers";
import { getBookingTimeline } from "@/lib/data/booking-history";
import { applyRateLimit, participantReadLimiter } from "@/lib/rate-limit";
import { reportSentryError } from "@/lib/observability/report";

interface RouteParams {
  params: Promise<{ appointmentId: string }>;
}

// Appointment.id is `@default(uuid())`, so anything else is a broken link
// rather than a miss — reject it before it reaches the database.
const TimelineParams = z.object({ appointmentId: z.string().uuid() });

export async function GET(_req: NextRequest, { params }: RouteParams) {
  try {
    const auth = await requireBackofficeSurface("appointments.manage");
    if (auth.error) return auth.error;

    const parsed = TimelineParams.safeParse(await params);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid appointment id" },
        { status: 400 },
      );
    }

    // No staff route has its own bucket, and this one is a per-appointment read
    // an operator opens by hand. `participantReadLimiter` is the platform's
    // 30/min-per-user read profile; the route slug keeps it from sharing a
    // counter with the participant lists, as `applyRateLimit` documents.
    const limited = await applyRateLimit(
      participantReadLimiter,
      `staff-timeline:${auth.session.user.id}`,
    );
    if (limited) return limited;

    const timeline = await getBookingTimeline(parsed.data.appointmentId, {
      kind: "all",
    });
    if (!timeline) {
      return NextResponse.json(
        { error: "Appointment not found" },
        { status: 404 },
      );
    }

    return NextResponse.json(timeline);
  } catch (error) {
    reportSentryError(error, {
      subsystem: "staff",
      op: "staff.appointments.timeline",
      expected: false,
    });
    return NextResponse.json(
      { error: "Failed to fetch appointment timeline" },
      { status: 500 },
    );
  }
}
