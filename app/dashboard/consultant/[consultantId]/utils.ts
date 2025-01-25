import {
  IAppointment,
  IDocument,
  IActivity,
  IApproval,
  ApiResponse,
} from "./types";
import { TConsultantProfile } from "@/types/consultant";
import {
  TAppointment,
  TConsultation,
  TSubscription,
} from "@/types/appointment";

export async function fetchConsultantData(
  consultantId: string,
): Promise<TConsultantProfile> {
  try {
    const response = await fetch(`/api/user/consultants/${consultantId}`);
    if (!response.ok) {
      throw new Error(
        `Failed to fetch consultant data: ${response.statusText}`,
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
  try {
    const response = await fetch(`/api/slots/appointments?consultantProfileId=${consultantId}&consultationStatus=APPROVED&subscriptionStatus=APPROVED&webinarStatus=APPROVED&classStatus=APPROVED`)
    if (!response.ok) {
      throw new Error(`Failed to fetch appointments: ${response.statusText}`);
    }
    const data: ApiResponse<TAppointment[]> = await response.json();

    // Transform the API response to match our IAppointment type
    return data.data.map((appointment) => ({
      id: appointment.id,
      appointmentType: appointment.appointmentType,
      slotsOfAppointment: appointment.slotsOfAppointment.map(slot => ({
        id: slot.id,
        slotStartTimeInUTC: new Date(slot.slotStartTimeInUTC).toISOString(),
        slotEndTimeInUTC: new Date(slot.slotEndTimeInUTC).toISOString(),
        isTentative: slot.isTentative,
        user: slot.user.map(u => ({
          id: u.id,
          name: u.name || 'Unknown User',
          email: u.email || '',
          image: u.image || '/placeholder.svg',
          currentTimezone: u.currentTimezone || 'UTC'
        }))
      })),
      consultation: appointment.consultation ? {
        id: appointment.consultation.id,
        consultationPlan: {
          id: appointment.consultation.consultationPlan.id,
          title: appointment.consultation.consultationPlan.title || 'Untitled Plan',
          description: appointment.consultation.consultationPlan.description || '',
          durationInHours: appointment.consultation.consultationPlan.durationInHours || 1
        },
        requestStatus: appointment.consultation.requestStatus || 'PENDING',
        requestedBy: {
          user: {
            name: appointment.consultation.requestedBy?.user?.name || 'Unknown User',
            image: appointment.consultation.requestedBy?.user?.image || '/placeholder.svg'
          }
        }
      } : undefined,
      subscription: appointment.subscription ? {
        id: appointment.subscription.id,
        subscriptionPlan: {
          id: appointment.subscription.subscriptionPlan.id,
          title: appointment.subscription.subscriptionPlan.title || 'Untitled Plan',
          description: appointment.subscription.subscriptionPlan.description || '',
          durationInMonths: appointment.subscription.subscriptionPlan.durationInMonths || 1,
          callsPerWeek: appointment.subscription.subscriptionPlan.callsPerWeek || 1
        },
        requestStatus: appointment.subscription.requestStatus || 'PENDING',
        requestedBy: {
          user: {
            name: appointment.subscription.requestedBy?.user?.name || 'Unknown User',
            image: appointment.subscription.requestedBy?.user?.image || '/placeholder.svg'
          }
        },
        startDate: new Date(appointment.subscription.startDate).toISOString(),
        endDate: new Date(appointment.subscription.endDate).toISOString()
      } : undefined,
      webinar: appointment.webinar ? {
        id: appointment.webinar.id,
        webinarPlan: {
          id: appointment.webinar.webinarPlan.id,
          title: appointment.webinar.webinarPlan.title || 'Untitled Plan',
          description: appointment.webinar.webinarPlan.description || '',
          durationInHours: appointment.webinar.webinarPlan.durationInHours || 1
        },
        status: appointment.webinar.status
      } : undefined,
      class: appointment.class ? {
        id: appointment.class.id,
        classPlan: {
          id: appointment.class.classPlan.id,
          title: appointment.class.classPlan.title || 'Untitled Plan',
          description: appointment.class.classPlan.description || '',
          durationInMonths: appointment.class.classPlan.durationInMonths || 1
        },
        status: appointment.class.status
      } : undefined
    }));
  } catch (error) {
    console.error("Error fetching appointments:", error);
    throw error;
  }
}

export async function fetchApprovals(
  consultantId: string,
): Promise<IApproval[]> {
  try {
    // Fetch both consultations and subscriptions
    const [consultationsRes, subscriptionsRes] = await Promise.all([
      fetch(
        `/api/events/consultations?consultantProfileId=${consultantId}&status=PENDING`,
      ),
      fetch(
        `/api/events/subscriptions?consultantProfileId=${consultantId}&status=PENDING`,
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
