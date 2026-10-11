import {
  TAppointment,
  TConsultation,
  TSubscription,
} from "@/types/appointment";
import { TConsultantProfile } from "@/types/consultant";
import { ApiResponse, DocumentsPage, IActivity, IApproval } from "../types";

export interface FetchDocumentsParams {
  limit?: number;
  offset?: number;
  status?: string;
  appointmentType?: string;
  uploadedByRole?: "CONSULTEE" | "CONSULTANT";
  orgScope?: string | null;
}

export interface DocumentFetchError extends Error {
  technicalMessage?: string;
  status?: number;
  originalError?: Error;
}

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

export async function fetchDocuments(
  consultantId: string,
  params: FetchDocumentsParams = {},
): Promise<DocumentsPage> {
  try {
    const qs = new URLSearchParams();
    if (params.limit !== undefined) qs.set("limit", String(params.limit));
    if (params.offset !== undefined) qs.set("offset", String(params.offset));
    if (params.status) qs.set("status", params.status);
    if (params.appointmentType)
      qs.set("appointmentType", params.appointmentType);
    if (params.uploadedByRole) qs.set("uploadedByRole", params.uploadedByRole);
    if (params.orgScope && params.orgScope !== "personal")
      qs.set("orgScope", params.orgScope);

    const query = qs.toString();
    const url = `/api/dashboard/consultant/${consultantId}/documents${query ? `?${query}` : ""}`;

    const response = await fetch(url);

    if (!response.ok) {
      let errorMessage = "Failed to load documents";
      let userFriendlyMessage =
        "Unable to load documents for review. Please try again.";

      try {
        const errorData = await response.json();
        if (errorData.message) {
          userFriendlyMessage = errorData.message;
        }
        errorMessage =
          errorData.error || `HTTP ${response.status}: ${response.statusText}`;
      } catch {
        errorMessage = `HTTP ${response.status}: ${response.statusText}`;
      }

      const enhancedError = new Error(
        userFriendlyMessage,
      ) as DocumentFetchError;
      enhancedError.name = "DocumentFetchError";
      enhancedError.technicalMessage = errorMessage;
      enhancedError.status = response.status;

      throw enhancedError;
    }

    const data = (await response.json()) as Partial<DocumentsPage>;

    const fallbackPagination = {
      limit: params.limit ?? 10,
      offset: params.offset ?? 0,
      totalCount: 0,
      totalPages: 1,
      currentPage: 1,
      hasNextPage: false,
      hasPrevPage: false,
    };
    const fallbackMetadata = {
      pendingCount: 0,
      reviewingCount: 0,
      needsRevisionCount: 0,
      completedCount: 0,
    };

    return {
      data: data.data ?? [],
      pagination: data.pagination ?? fallbackPagination,
      metadata: data.metadata ?? fallbackMetadata,
      count: data.count,
      message: data.message,
      consultant: data.consultant,
      filters: data.filters,
    };
  } catch (error) {
    if (error instanceof Error) {
      if (error.name === "DocumentFetchError") {
        throw error;
      }

      const enhancedError = new Error(
        "Unable to connect to the document system. Please try again.",
      ) as DocumentFetchError;
      enhancedError.name = "DocumentFetchError";
      enhancedError.technicalMessage = error.message;
      enhancedError.originalError = error;
      throw enhancedError;
    }

    const fallbackError = new Error(
      "An unknown error occurred while loading documents. Please try again.",
    ) as DocumentFetchError;
    fallbackError.name = "DocumentFetchError";
    fallbackError.technicalMessage = String(error);
    throw fallbackError;
  }
}
