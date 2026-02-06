import { useState, useEffect } from "react";
import { useToast } from "@/components/ui/use-toast";
import {
  TConsultation,
  TSubscription,
  TWebinar,
  TClass,
  TAppointment,
} from "@/types/appointment";

export type ConsultationWithPlan = TConsultation & {
  appointment: TAppointment | null;
};

export type SubscriptionWithPlan = TSubscription & {
  appointments: TAppointment[];
};

export type WebinarWithPlan = TWebinar & {
  appointment: TAppointment | null;
};

export type ClassWithPlan = TClass & {
  appointment: TAppointment[];
};

// Trial session type for consultee dashboard
export type TrialWithPlan = {
  id: string;
  status: string;
  notes: string | null;
  requestedAt: string;
  completedAt: string | null;
  subscriptionPlan: {
    id: string;
    title: string;
    freeTrialDurationMinutes: number;
    consultantProfile: {
      id: string;
      user: {
        id: string;
        name: string;
        image: string | null;
        email: string;
      };
    };
  };
  appointment: TAppointment | null;
};

// --- Internal types ---

type EventQueryMode =
  | { type: "consultee"; profileId: string }
  | { type: "consultant"; profileId: string }
  | { type: "user"; userId: string };

interface EventsResult {
  consultations: ConsultationWithPlan[];
  subscriptions: SubscriptionWithPlan[];
  webinars: WebinarWithPlan[];
  classes: ClassWithPlan[];
  isLoading: boolean;
  error: Error | null;
}

// --- Single internal implementation ---

function useEventsInternal(mode: EventQueryMode): EventsResult {
  const [consultations, setConsultations] = useState<ConsultationWithPlan[]>(
    [],
  );
  const [subscriptions, setSubscriptions] = useState<SubscriptionWithPlan[]>(
    [],
  );
  const [webinars, setWebinars] = useState<WebinarWithPlan[]>([]);
  const [classes, setClasses] = useState<ClassWithPlan[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const { toast } = useToast();

  // Stable key for the effect dependency
  const modeKey =
    mode.type === "user"
      ? `user:${mode.userId}`
      : mode.type === "consultant"
        ? `consultant:${mode.profileId}`
        : `consultee:${mode.profileId}`;

  useEffect(() => {
    const identifier = mode.type === "user" ? mode.userId : mode.profileId;
    if (!identifier) return;

    const fetchEvents = async () => {
      setIsLoading(true);
      setError(null);

      try {
        let queryParam: string;

        if (mode.type === "user") {
          // Fetch user details first to determine role
          const response = await fetch(`/api/user/${mode.userId}`);
          if (!response.ok) {
            throw new Error("Failed to fetch user details");
          }
          const userData = await response.json();
          const userDetails = userData.data;

          if (!userDetails) {
            throw new Error("User details not found");
          }

          if (
            userDetails.role === "CONSULTANT" &&
            userDetails.consultantProfile?.id
          ) {
            queryParam = `consultantProfileId=${userDetails.consultantProfile.id}`;
          } else if (
            userDetails.role === "CONSULTEE" &&
            userDetails.consulteeProfile?.id
          ) {
            queryParam = `consulteeProfileId=${userDetails.consulteeProfile.id}`;
          } else {
            // If role or profile is not found, use empty arrays
            setConsultations([]);
            setSubscriptions([]);
            setWebinars([]);
            setClasses([]);
            setIsLoading(false);
            return;
          }
        } else if (mode.type === "consultant") {
          queryParam = `consultantProfileId=${mode.profileId}`;
        } else {
          queryParam = `consulteeProfileId=${mode.profileId}`;
        }

        const [consultationsRes, subscriptionsRes, webinarsRes, classesRes] =
          await Promise.all([
            fetch(`/api/events/consultations?${queryParam}`),
            fetch(`/api/events/subscriptions?${queryParam}`),
            fetch(`/api/events/webinars?${queryParam}`),
            fetch(`/api/events/classes?${queryParam}`),
          ]);

        if (
          !consultationsRes.ok ||
          !subscriptionsRes.ok ||
          !webinarsRes.ok ||
          !classesRes.ok
        ) {
          throw new Error("Failed to fetch events");
        }

        const consultationsData = await consultationsRes.json();
        const subscriptionsData = await subscriptionsRes.json();
        const webinarsData = await webinarsRes.json();
        const classesData = await classesRes.json();

        setConsultations(consultationsData.data);
        setSubscriptions(subscriptionsData.data);
        setWebinars(webinarsData.data);
        setClasses(classesData.data);
      } catch (err: any) {
        console.error("Error fetching events:", err);
        setError(err);
        toast({
          title: "Error fetching events",
          description: err.message,
          variant: "destructive",
        });
      } finally {
        setIsLoading(false);
      }
    };

    fetchEvents();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modeKey, toast]);

  return { consultations, subscriptions, webinars, classes, isLoading, error };
}

// --- Public API (signatures unchanged) ---

/** Fetch events for a consultee profile */
export const useEvents = (consulteeProfileId: string) =>
  useEventsInternal({ type: "consultee", profileId: consulteeProfileId });

/** Fetch events for a consultee profile */
export const useEventsByConsultee = (consulteeProfileId: string) =>
  useEventsInternal({ type: "consultee", profileId: consulteeProfileId });

/** Fetch events for a consultant profile */
export const useEventsByConsultant = (consultantProfileId: string) =>
  useEventsInternal({ type: "consultant", profileId: consultantProfileId });

/** Fetch events for a user (auto-detects role) */
export const useEventsByUser = (userId: string) =>
  useEventsInternal({ type: "user", userId });
