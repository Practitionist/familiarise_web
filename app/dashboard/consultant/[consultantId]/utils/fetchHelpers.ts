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
      let errorMessage = 'Failed to load documents';
      let userFriendlyMessage = 'Unable to load documents for review. Please try again.';
      
      try {
        const errorData = await response.json();
        
        // Use the enhanced error messages from the API
        if (errorData.message) {
          userFriendlyMessage = errorData.message;
        }
        
        // Provide specific messages based on error codes
        switch (errorData.code) {
          case 'UNAUTHORIZED':
            userFriendlyMessage = 'Please sign in again to view documents.';
            break;
          case 'ACCESS_DENIED':
            userFriendlyMessage = 'You don\'t have permission to view these documents. Please check that you\'re accessing the correct consultant dashboard.';
            break;
          case 'CONNECTION_ERROR':
            userFriendlyMessage = 'Connection issue detected. Please check your internet connection and try again.';
            break;
          case 'DATABASE_ERROR':
            userFriendlyMessage = 'Document system is temporarily unavailable. Please try again in a few moments.';
            break;
          case 'INVALID_FILTER':
            userFriendlyMessage = errorData.message || 'Invalid filter applied. Please check your search criteria.';
            break;
          default:
            // Use the message from API if available, otherwise fall back to default
            userFriendlyMessage = errorData.message || userFriendlyMessage;
        }
        
        errorMessage = errorData.error || `HTTP ${response.status}: ${response.statusText}`;
      } catch (parseError) {
        // If we can't parse the error response, provide helpful messages based on status codes
        switch (response.status) {
          case 401:
            userFriendlyMessage = 'Please sign in again to view documents.';
            break;
          case 403:
            userFriendlyMessage = 'Access denied. Please check that you have permission to view these documents.';
            break;
          case 404:
            userFriendlyMessage = 'Consultant profile not found. Please check the URL and try again.';
            break;
          case 500:
            userFriendlyMessage = 'Server error occurred. Please try again later or contact support.';
            break;
          case 503:
            userFriendlyMessage = 'Document system is temporarily unavailable. Please try again in a few moments.';
            break;
          default:
            userFriendlyMessage = `Unable to load documents (Error ${response.status}). Please try again.`;
        }
        errorMessage = `HTTP ${response.status}: ${response.statusText}`;
      }
      
      // Create an enhanced error with both technical and user-friendly messages
      const enhancedError = new Error(userFriendlyMessage);
      enhancedError.name = 'DocumentFetchError';
      (enhancedError as any).technicalMessage = errorMessage;
      (enhancedError as any).status = response.status;
      
      throw enhancedError;
    }
    
    const data: ApiResponse<IDocument[]> = await response.json();
    
    // Handle successful response but validate data structure
    if (!data.data) {
      console.warn('API response missing data array, returning empty array');
      return [];
    }
    
    // Log helpful information for debugging
    if (data.message) {
      console.info('Documents API message:', data.message);
    }
    
    return data.data;
  } catch (error) {
    // Handle network errors and other exceptions
    if (error instanceof Error) {
      // If it's already our enhanced error, re-throw it
      if (error.name === 'DocumentFetchError') {
        throw error;
      }
      
      // Handle network and other errors
      let userFriendlyMessage = 'Unable to connect to the document system.';
      
      if (error.message.includes('fetch')) {
        userFriendlyMessage = 'Network error: Please check your internet connection and try again.';
      } else if (error.message.includes('timeout')) {
        userFriendlyMessage = 'Request timed out: The server is taking too long to respond. Please try again.';
      } else if (error.message.includes('JSON')) {
        userFriendlyMessage = 'Data format error: Please refresh the page and try again.';
      } else {
        userFriendlyMessage = 'An unexpected error occurred while loading documents. Please try again.';
      }
      
      const enhancedError = new Error(userFriendlyMessage);
      enhancedError.name = 'DocumentFetchError';
      (enhancedError as any).technicalMessage = error.message;
      (enhancedError as any).originalError = error;
      
      console.error("Enhanced error fetching documents:", {
        userMessage: userFriendlyMessage,
        technicalMessage: error.message,
        stack: error.stack
      });
      
      throw enhancedError;
    }
    
    // Handle non-Error objects (shouldn't happen, but just in case)
    const fallbackError = new Error('An unknown error occurred while loading documents. Please try again.');
    fallbackError.name = 'DocumentFetchError';
    (fallbackError as any).technicalMessage = String(error);
    
    console.error("Unknown error fetching documents:", error);
    throw fallbackError;
  }
}
