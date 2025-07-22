import {
  TAppointment,
  TConsultation,
  TSubscription,
} from "@/types/appointment";
import { TConsultantProfile } from "@/types/consultant";
import { ApiResponse, IActivity, IApproval, IDocument } from "../types";

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
): Promise<TAppointment[]> {
  const baseUrl = getBaseUrl();
  try {
    const response = await fetch(
      `${baseUrl}/api/slots/appointments?consultantProfileId=${consultantId}&consultationStatus=APPROVED&subscriptionStatus=APPROVED&webinarStatus=APPROVED&classStatus=APPROVED`,
    );
    if (!response.ok) {
      throw new Error(`Failed to fetch appointments: ${response.statusText}`);
    }
    const data: ApiResponse<TAppointment[]> = await response.json();

    // Return the data directly as TAppointment[] since we're now using TAppointment everywhere
    return data.data;
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

    if (!consultationsRes.ok || !subscriptionsRes.ok) {
      throw new Error("Failed to fetch approvals");
    }

    const consultationsData: ApiResponse<TConsultation[]> =
      await consultationsRes.json();
    const subscriptionsData: ApiResponse<TSubscription[]> =
      await subscriptionsRes.json();

    // Transform to IApproval format
    const approvals: IApproval[] = [];

    // Add consultations
    consultationsData.data.forEach((consultation: TConsultation) => {
      approvals.push({
        id: consultation.id,
        name: consultation.requestedBy?.user?.name || "Unknown",
        type: "Consultation",
        date: new Date(consultation.requestedAt).toLocaleDateString(),
        time: new Date(consultation.requestedAt).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        }),
      });
    });

    // Add subscriptions
    subscriptionsData.data.forEach((subscription: TSubscription) => {
      approvals.push({
        id: subscription.id,
        name: subscription.requestedBy?.user?.name || "Unknown",
        type: "Subscription",
        date: new Date(subscription.requestedAt).toLocaleDateString(),
        time: new Date(subscription.requestedAt).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        }),
      });
    });

    return approvals;
  } catch (error) {
    console.error("Error fetching approvals:", error);
    throw error;
  }
}

export async function fetchActivities(
  consultantId: string,
): Promise<IActivity[]> {
  const baseUrl = getBaseUrl();
  try {
    const response = await fetch(
      `${baseUrl}/api/activities?consultantId=${consultantId}`,
    );
    if (!response.ok) {
      throw new Error(`Failed to fetch activities: ${response.statusText}`);
    }
    const data: ApiResponse<IActivity[]> = await response.json();
    return data.data;
  } catch (error) {
    console.error("Error fetching activities:", error);
    throw error;
  }
}

export async function fetchDocuments(
  consultantId: string,
): Promise<IDocument[]> {
  const baseUrl = getBaseUrl();
  try {
    const response = await fetch(
      `${baseUrl}/api/dashboard/consultant/${consultantId}/documents`,
    );
    if (!response.ok) {
      throw new Error(`Failed to fetch documents: ${response.statusText}`);
    }
    const data: ApiResponse<IDocument[]> = await response.json();
    return data.data;
  } catch (error) {
    console.error("Error fetching documents:", error);
    throw error;
  }
}
