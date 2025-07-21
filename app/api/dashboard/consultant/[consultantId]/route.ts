import { NextRequest, NextResponse } from "next/server";
import {
  TAppointment,
  TConsultation,
  TSubscription,
} from "@/types/appointment";
import { ApiResponse } from "@/app/dashboard/consultant/[consultantId]/types";

// Helper to get the base URL, preferring VERCEL_URL if available
const getBaseUrl = () => {
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
};

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ consultantId: string }> }
) {
  try {
    const resolvedParams = await params;
    const { consultantId } = resolvedParams;
    const baseUrl = getBaseUrl();

    // Fetch all dashboard data in parallel
    const [appointmentsRes, consultationsRes, subscriptionsRes] =
      await Promise.all([
        fetch(
          `${baseUrl}/api/slots/appointments?consultantProfileId=${consultantId}&consultationStatus=APPROVED&subscriptionStatus=APPROVED&webinarStatus=APPROVED&classStatus=APPROVED`,
          { headers: { Cookie: request.headers.get("cookie") || "" } }
        ),
        fetch(
          `${baseUrl}/api/events/consultations?consultantProfileId=${consultantId}&status=PENDING`,
          { headers: { Cookie: request.headers.get("cookie") || "" } }
        ),
        fetch(
          `${baseUrl}/api/events/subscriptions?consultantProfileId=${consultantId}&status=PENDING`,
          { headers: { Cookie: request.headers.get("cookie") || "" } }
        ),
      ]);

    // Check for errors
    if (!appointmentsRes.ok) {
      throw new Error(
        `Failed to fetch appointments: ${appointmentsRes.statusText}`
      );
    }
    if (!consultationsRes.ok) {
      throw new Error(
        `Failed to fetch consultations: ${consultationsRes.statusText}`
      );
    }
    if (!subscriptionsRes.ok) {
      throw new Error(
        `Failed to fetch subscriptions: ${subscriptionsRes.statusText}`
      );
    }

    // Parse responses
    const appointmentsData: ApiResponse<TAppointment[]> =
      await appointmentsRes.json();
    const consultationsData: ApiResponse<TConsultation[]> =
      await consultationsRes.json();
    const subscriptionsData: ApiResponse<TSubscription[]> =
      await subscriptionsRes.json();

    // Transform appointments (same logic as fetchHelpers.ts)
    const transformedAppointments = appointmentsData.data.map(
      (appointment) => ({
        id: appointment.id,
        appointmentType: appointment.appointmentType,
        slotsOfAppointment: appointment.slotsOfAppointment.map((slot) => ({
          id: slot.id,
          slotStartTimeInUTC: new Date(slot.slotStartTimeInUTC),
          slotEndTimeInUTC: slot.slotEndTimeInUTC
            ? new Date(slot.slotEndTimeInUTC)
            : null,
          isTentative: slot.isTentative,
          user: Array.isArray(slot.user)
            ? slot.user.map((u) => ({
                id: u.id,
                name: u.name,
                email: u.email,
                image: u.image,
                phone: u.phone || null,
                address: u.address || null,
                password: u.password || null,
                passwordResetToken: u.passwordResetToken || null,
                passwordResetExpires: u.passwordResetExpires || null,
                onlineStatus: u.onlineStatus,
                currentTimezone: u.currentTimezone || null,
                onboardingCompleted: u.onboardingCompleted,
                role: u.role,
                consultantProfileId: u.consultantProfileId,
                consulteeProfileId: u.consulteeProfileId,
                staffProfileId: u.staffProfileId,
              }))
            : [],
        })),
        consultation: appointment.consultation
          ? {
              id: appointment.consultation.id,
              consultationPlan: {
                ...appointment.consultation.consultationPlan,
                consultantProfile: appointment.consultation.consultationPlan
                  .consultantProfile as any,
              },
              requestStatus: appointment.consultation.requestStatus,
              requestedBy: {
                id: appointment.consultation.requestedBy?.id ?? "",
                user: {
                  name:
                    appointment.consultation.requestedBy?.user?.name ?? null,
                  image:
                    appointment.consultation.requestedBy?.user?.image ?? null,
                },
              },
            }
          : undefined,
        subscription: appointment.subscription
          ? {
              id: appointment.subscription.id,
              subscriptionPlan: {
                ...appointment.subscription.subscriptionPlan,
                consultantProfile: appointment.subscription.subscriptionPlan
                  .consultantProfile as any,
              },
              requestStatus: appointment.subscription.requestStatus,
              requestedBy: {
                id: appointment.subscription.requestedBy?.id ?? "",
                user: {
                  name:
                    appointment.subscription.requestedBy?.user?.name ?? null,
                  image:
                    appointment.subscription.requestedBy?.user?.image ?? null,
                },
              },
              startDate: new Date(
                appointment.subscription.startDate
              ).toISOString(),
              endDate: new Date(appointment.subscription.endDate).toISOString(),
            }
          : undefined,
        webinar: appointment.webinar
          ? {
              id: appointment.webinar.id,
              webinarPlan: {
                ...appointment.webinar.webinarPlan,
                consultantProfile: appointment.webinar.webinarPlan
                  .consultantProfile as any,
              },
              status: appointment.webinar.status,
            }
          : undefined,
        class: appointment.class
          ? {
              id: appointment.class.id,
              classPlan: {
                ...appointment.class.classPlan,
                consultantProfile: appointment.class.classPlan
                  .consultantProfile as any,
              },
              status: appointment.class.status,
            }
          : undefined,
      })
    );

    // Transform approvals (same logic as fetchHelpers.ts)
    const consultationApprovals = consultationsData.data.map(
      (consultation: TConsultation) => ({
        id: consultation.id,
        type: "Consultation",
        name: consultation.requestedBy?.user?.name ?? "Unknown",
        requestedAt: consultation.requestedAt,
      })
    );

    const subscriptionApprovals = subscriptionsData.data.map(
      (subscription: TSubscription) => ({
        id: subscription.id,
        type: "Subscription",
        name: subscription.requestedBy?.user?.name ?? "Unknown",
        requestedAt: subscription.requestedAt,
      })
    );

    // Sort by requestedAt (ISO string) for type safety
    const sortedApprovals = [
      ...consultationApprovals,
      ...subscriptionApprovals,
    ].sort(
      (a, b) =>
        new Date(b.requestedAt).getTime() - new Date(a.requestedAt).getTime()
    );

    // Map to display format for response
    const approvals = sortedApprovals.map((approval) => ({
      id: approval.id,
      type: approval.type,
      name: approval.name,
      date: formatDate(approval.requestedAt),
      time: formatTime(approval.requestedAt),
    }));

    // Activities are empty for now (as in original)
    const activities: any[] = [];

    // Return consolidated response
    return NextResponse.json({
      success: true,
      data: {
        appointments: transformedAppointments,
        activities,
        approvals,
      },
    });
  } catch (error) {
    console.error("Error fetching dashboard data:", error);
    return NextResponse.json(
      {
        success: false,
        error: "Failed to fetch dashboard data",
        message: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}

function formatDate(dateString?: string | Date | null): string {
  if (!dateString) return "Date not set";
  const date = new Date(dateString);
  if (isNaN(date.getTime())) return "Invalid date";

  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatTime(dateString?: string | Date | null): string {
  if (!dateString) return "Time not set";
  const date = new Date(dateString);
  if (isNaN(date.getTime())) return "Invalid time";

  return date.toLocaleString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}
