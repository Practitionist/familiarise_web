import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { getSession } from "@/lib/auth-server";
import { isPrivileged } from "@/lib/auth-helpers";
import {
  readAppointmentDetail,
  type TAppointmentDetail,
} from "@/lib/data/appointment-detail";

/** Every party to the appointment may read it: the requesting consultee (or
 *  trial consultee, or a slot participant), the plan's consultant, and
 *  ACCEPTED collaborators. Platform ADMIN/STAFF read for support. */
function canReadAppointment(
  userId: string,
  detail: TAppointmentDetail,
): boolean {
  const { appointment } = detail;
  const consulteeUserIds = [
    appointment.consultation?.requestedBy?.userId,
    appointment.subscription?.requestedBy?.userId,
    appointment.trialSession?.consulteeProfile?.userId,
    ...appointment.slotsOfAppointment.flatMap((slot) =>
      slot.user.map((u) => u.id),
    ),
  ];
  const consultantUserIds = [
    appointment.consultation?.consultationPlan?.consultantProfile?.userId,
    appointment.subscription?.subscriptionPlan?.consultantProfile?.userId,
    appointment.webinar?.webinarPlan?.consultantProfile?.userId,
    appointment.class?.classPlan?.consultantProfile?.userId,
    appointment.trialSession?.subscriptionPlan?.consultantProfile?.userId,
    ...(appointment.webinar?.webinarPlan?.collaborators ?? []).map(
      (c) => c.consultantProfile?.userId,
    ),
    ...(appointment.class?.classPlan?.collaborators ?? []).map(
      (c) => c.consultantProfile?.userId,
    ),
  ];
  return [...consulteeUserIds, ...consultantUserIds].includes(userId);
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ appointmentId: string }> },
) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { appointmentId } = await params;
    const detail = await readAppointmentDetail(appointmentId);
    if (!detail) {
      return NextResponse.json(
        { error: "Appointment not found" },
        { status: 404 },
      );
    }

    if (
      !canReadAppointment(session.user.id, detail) &&
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
