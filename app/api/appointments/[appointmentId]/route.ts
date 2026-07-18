import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { z } from "zod";
import { getSession } from "@/lib/auth-server";
import { isPrivileged } from "@/lib/auth-helpers";
import {
  readAppointmentDetail,
  canAccessAppointment,
} from "@/lib/data/appointment-detail";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ appointmentId: string }> },
) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const parsed = z
      .object({ appointmentId: z.string().uuid() })
      .safeParse(await params);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid appointment id" },
        { status: 400 },
      );
    }
    const { appointmentId } = parsed.data;
    const detail = await readAppointmentDetail(appointmentId);
    if (!detail) {
      return NextResponse.json(
        { error: "Appointment not found" },
        { status: 404 },
      );
    }

    if (
      !canAccessAppointment(session.user.id, detail) &&
      !isPrivileged(session.user.role)
    ) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    return NextResponse.json({ data: detail });
  } catch (error) {
    Sentry.captureException(error);
    console.error("Error fetching appointment detail:", error);
    return NextResponse.json(
      { error: "Failed to fetch appointment" },
      { status: 500 },
    );
  }
}
