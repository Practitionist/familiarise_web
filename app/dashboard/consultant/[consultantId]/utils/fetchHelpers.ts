import {
  TAppointment,
  TConsultation,
  TSubscription,
} from "@/types/appointment";
import { TConsultantProfile } from "@/types/consultant";
import {
  ApiResponse,
  IActivity,
  IAppointment,
  IApproval,
  IDocument,
} from "../types";

// Helper to get the base URL, preferring VERCEL_URL if available
const getBaseUrl = () => {
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  // Fallback for local development
  return process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
};

export async function fetchConsultantData(
  consultantId: string,
): Promise<TConsultantProfile> {
  const baseUrl = getBaseUrl();
  try {
    const response = await fetch(
      `${baseUrl}/api/user/consultants/${consultantId}`,
    );
    if (!response.ok) {
      if (response.status === 404) {
        throw new Error(
          "This consultant profile could not be found. The consultant may not exist or may have been removed.",
        );
      }
      if (response.status === 401) {
        throw new Error(
          "You are not authorized to view this consultant profile. Please log in and try again.",
        );
      }
      if (response.status === 500) {
        throw new Error(
          "We're experiencing technical difficulties. Please try again in a few moments.",
        );
      }
      throw new Error(
        `Unable to load consultant profile. Please try again later. (Error: ${response.status})`,
      );
    }
    const data: ApiResponse<TConsultantProfile> = await response.json();
    return data.data;
  } catch (error) {
    console.error("Error fetching consultant data:", error);
    throw error;
  }
}

export async function fetchAppointments(
  consultantId: string,
): Promise<IAppointment[]> {
  const baseUrl = getBaseUrl();
  try {
    const response = await fetch(
      `${baseUrl}/api/slots/appointments?consultantProfileId=${consultantId}&consultationStatus=APPROVED&subscriptionStatus=APPROVED&webinarStatus=APPROVED&classStatus=APPROVED`,
    );
    if (!response.ok) {
      throw new Error(`Failed to fetch appointments: ${response.statusText}`);
    }
    const data: ApiResponse<TAppointment[]> = await response.json();

    // Transform the API response to match our IAppointment type (which expects Date objects)
    return data.data.map((appointment) => ({
      id: appointment.id,
      appointmentType: appointment.appointmentType,
      slotsOfAppointment: appointment.slotsOfAppointment.map((slot) => ({
        id: slot.id,
        // Convert string dates from API/TAppointment to Date objects for IAppointment
        slotStartTimeInUTC: new Date(slot.slotStartTimeInUTC),
        slotEndTimeInUTC: slot.slotEndTimeInUTC
          ? new Date(slot.slotEndTimeInUTC)
          : null,
        isTentative: slot.isTentative,
        // Map the user array to match IUser[] type expected by ISlotOfAppointment
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
      // Map other relations, ensuring nested types match IAppointment definitions
      consultation: appointment.consultation
        ? {
            id: appointment.consultation.id,
            consultationPlan: {
              // Ensure consultationPlan structure matches IConsultationPlan
              ...appointment.consultation.consultationPlan,
              // consultantProfile needs to be mapped if IConsultationPlan expects it
              consultantProfile: appointment.consultation.consultationPlan
                .consultantProfile as any, // Cast if necessary
            },
            requestStatus: appointment.consultation.requestStatus,
            requestedBy: {
              id: appointment.consultation.requestedBy?.id ?? "",
              user: {
                name: appointment.consultation.requestedBy?.user?.name ?? null,
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
                .consultantProfile as any, // Cast if necessary
            },
            requestStatus: appointment.subscription.requestStatus,
            requestedBy: {
              id: appointment.subscription.requestedBy?.id ?? "",
              user: {
                name: appointment.subscription.requestedBy?.user?.name ?? null,
                image:
                  appointment.subscription.requestedBy?.user?.image ?? null,
              },
            },
            startDate: new Date(
              appointment.subscription.startDate,
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
                .consultantProfile as any, // Cast if necessary
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
                .consultantProfile as any, // Cast if necessary
            },
            status: appointment.class.status,
          }
        : undefined,
    }));
  } catch (error) {
    console.error("Error fetching appointments:", error);
    throw error;
  }
}

export async function fetchApprovals(
  consultantId: string,
): Promise<IApproval[]> {
  const baseUrl = getBaseUrl();
  try {
    // Fetch both consultations and subscriptions
    const [consultationsRes, subscriptionsRes] = await Promise.all([
      fetch(
        `${baseUrl}/api/events/consultations?consultantProfileId=${consultantId}&status=PENDING`,
      ),
      fetch(
        `${baseUrl}/api/events/subscriptions?consultantProfileId=${consultantId}&status=PENDING`,
      ),
    ]);

    if (!consultationsRes.ok) {
      throw new Error(
        `Failed to fetch consultations: ${consultationsRes.statusText}`,
      );
    }
    if (!subscriptionsRes.ok) {
      throw new Error(
        `Failed to fetch subscriptions: ${subscriptionsRes.statusText}`,
      );
    }

    const consultationsData: ApiResponse<TConsultation[]> =
      await consultationsRes.json();
    const subscriptionsData: ApiResponse<TSubscription[]> =
      await subscriptionsRes.json();

    // Transform consultations into approvals
    const consultationApprovals = consultationsData.data.map(
      (consultation: TConsultation) => ({
        id: consultation.id,
        type: "Consultation",
        name: consultation.requestedBy?.user?.name ?? "Unknown",
        date: formatDate(consultation.requestedAt),
        time: formatTime(consultation.requestedAt),
      }),
    );

    // Transform subscriptions into approvals
    const subscriptionApprovals = subscriptionsData.data.map(
      (subscription: TSubscription) => ({
        id: subscription.id,
        type: "Subscription",
        name: subscription.requestedBy?.user?.name ?? "Unknown",
        date: formatDate(subscription.requestedAt),
        time: formatTime(subscription.requestedAt),
      }),
    );

    // Combine and sort by requestedAt
    return [...consultationApprovals, ...subscriptionApprovals].sort(
      (a, b) =>
        new Date(`${b.date} ${b.time}`).getTime() -
        new Date(`${a.date} ${a.time}`).getTime(),
    );
  } catch (error) {
    console.error("Error fetching approvals:", error);
    throw error;
  }
}

export async function fetchActivities(
  _consultantId: string,
): Promise<IActivity[]> {
  // TODO: Implement activity tracking
  return [];
}

export async function fetchDocuments(
  _consultantId: string,
): Promise<IDocument[]> {
  // TODO: Implement document management
  return [];
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
