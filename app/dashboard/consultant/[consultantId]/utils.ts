import {
  Appointment,
  Document,
  Activity,
  Approval,
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
      throw new Error("Failed to fetch consultant data");
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
): Promise<Appointment[]> {
  try {
    const response = await fetch(
      `/api/slots/appointments?consultantProfileId=${consultantId}`,
    );
    if (!response.ok) {
      throw new Error("Failed to fetch appointments");
    }
    const data: ApiResponse<TAppointment[]> = await response.json();

    // Transform the API response to match our Appointment type
    return data.data.map((appointment) => ({
      id: appointment.id,
      name:
        appointment.slotOfAppointment?.[0]?.consulteeProfile?.user?.name ||
        "Unknown",
      description: getAppointmentDescription(appointment),
      time: formatAppointmentTime(
        appointment.slotOfAppointment?.[0]?.slotStartTimeInUTC?.toString(),
      ),
      badge: getAppointmentBadge(
        appointment.slotOfAppointment?.[0]?.slotStartTimeInUTC?.toString(),
      ),
    }));
  } catch (error) {
    console.error("Error fetching appointments:", error);
    throw error;
  }
}

export async function fetchApprovals(
  consultantId: string,
): Promise<Approval[]> {
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

    if (!consultationsRes.ok || !subscriptionsRes.ok) {
      throw new Error("Failed to fetch approvals");
    }

    const consultationsData = await consultationsRes.json();
    const subscriptionsData = await subscriptionsRes.json();

    // Transform consultations into approvals
    const consultationApprovals = consultationsData.data.map(
      (consultation: TConsultation) => ({
        id: consultation.id,
        type: "Consultation",
        name: consultation.requestedBy?.user?.name || "Unknown",
        date: formatDate(new Date(consultation.requestedAt)),
        time: formatTime(new Date(consultation.requestedAt)),
      }),
    );

    // Transform subscriptions into approvals
    const subscriptionApprovals = subscriptionsData.data.map(
      (subscription: TSubscription) => ({
        id: subscription.id,
        type: "Subscription",
        name: subscription.requestedBy?.user?.name || "Unknown",
        date: formatDate(new Date(subscription.requestedAt)),
        time: formatTime(new Date(subscription.requestedAt)),
      }),
    );

    // Combine and sort by requestedAt
    return [...consultationApprovals, ...subscriptionApprovals].sort(
      (a, b) =>
        new Date(b.date + " " + b.time).getTime() -
        new Date(a.date + " " + a.time).getTime(),
    );
  } catch (error) {
    console.error("Error fetching approvals:", error);
    throw error;
  }
}

export async function fetchActivities(
  _consultantId: string,
): Promise<Activity[]> {
  // TODO: Implement activity tracking
  return [];
}

export async function fetchDocuments(
  _consultantId: string,
): Promise<Document[]> {
  // TODO: Implement document management
  return [];
}

// Helper functions
function getAppointmentDescription(appointment: TAppointment): string {
  const type = appointment.appointmentType?.toLowerCase();
  switch (type) {
    case "consultation":
      return `Consultation - ${appointment.consultation?.consultationPlan?.title || "No title"}`;
    case "subscription":
      return `Subscription - ${appointment.subscription?.plan?.title || "No title"}`;
    case "webinar":
      return `Webinar - ${appointment.webinar?.webinarPlan?.title || "No title"}`;
    case "class":
      return `Class - ${appointment.class?.classPlan?.title || "No title"}`;
    default:
      return "Appointment";
  }
}

function formatAppointmentTime(dateString: string): string {
  if (!dateString) return "Time not set";
  const date = new Date(dateString);
  return date.toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

function getAppointmentBadge(dateString: string): string {
  if (!dateString) return "Schedule unavailable";

  const appointmentTime = new Date(dateString);
  const now = new Date();
  const diffInMinutes = Math.floor(
    (appointmentTime.getTime() - now.getTime()) / (1000 * 60),
  );

  if (diffInMinutes < -30) return "Completed";
  if (diffInMinutes <= 5) return "Meeting in 5 min";
  if (diffInMinutes <= 120) return "Meeting in 2 hours";

  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(0, 0, 0, 0);
  const dayAfterTomorrow = new Date(tomorrow);
  dayAfterTomorrow.setDate(dayAfterTomorrow.getDate() + 1);

  if (appointmentTime >= tomorrow && appointmentTime < dayAfterTomorrow) {
    return "Tomorrow";
  }

  const diffInDays = Math.floor(diffInMinutes / (24 * 60));
  if (diffInDays < 7) return `In ${diffInDays} days`;
  if (diffInDays < 30) return `In ${Math.floor(diffInDays / 7)} weeks`;
  if (diffInDays < 365) return `In ${Math.floor(diffInDays / 30)} months`;
  return `In ${Math.floor(diffInDays / 365)} years`;
}

function formatDate(date: Date): string {
  if (!date) return "Date not set";
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatTime(date: Date): string {
  if (!date) return "Time not set";
  return date.toLocaleString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}
