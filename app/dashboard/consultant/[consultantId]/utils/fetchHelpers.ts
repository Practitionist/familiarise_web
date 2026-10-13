import {
  TAppointment,
  TConsultation,
  TSubscription,
} from "@/types/appointment";
import { TConsultantProfile } from "@/types/consultant";
import { ApiResponse, IActivity, IApproval } from "../types";

export async function fetchConsultantData(
  consultantId: string,
): Promise<TConsultantProfile> {
  try {
    const response = await fetch(`/api/user/consultants/${consultantId}`, {
      cache: "no-store",
    });
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
  try {
    const response = await fetch(
      `/api/scheduling/appointments?consultantProfileId=${consultantId}&consultationStatus=APPROVED&subscriptionStatus=APPROVED&webinarStatus=APPROVED&classStatus=APPROVED`,
    );
    if (!response.ok) {
      throw new Error(`Failed to fetch appointments: ${response.statusText}`);
    }
    const data: ApiResponse<TAppointment[]> = await response.json();
    return data.data;
  } catch (error) {
    console.error("Error fetching appointments:", error);
    throw error;
  }
}

export async function fetchApprovals(
  consultantId: string,
): Promise<IApproval[]> {
  try {
    const [consultationsRes, subscriptionsRes] = await Promise.all([
      fetch(
        `/api/bookings/consultations?consultantProfileId=${consultantId}&status=PENDING`,
      ),
      fetch(
        `/api/bookings/subscriptions?consultantProfileId=${consultantId}&status=PENDING`,
      ),
    ]);

    if (!consultationsRes.ok || !subscriptionsRes.ok) {
      throw new Error("Failed to fetch approvals");
    }

    const consultationsData: ApiResponse<TConsultation[]> =
      await consultationsRes.json();
    const subscriptionsData: ApiResponse<TSubscription[]> =
      await subscriptionsRes.json();

    const approvals: IApproval[] = [];

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
  try {
    const response = await fetch(
      `/api/activities?consultantId=${consultantId}`,
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
