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

// Original hook for consultee events
// TODO: Replace with useEventsByConsultee
export const useEvents = (consulteeProfileId: string) => {
  const [consultations, setConsultations] = useState<ConsultationWithPlan[]>([]);
  const [subscriptions, setSubscriptions] = useState<SubscriptionWithPlan[]>([]);
  const [webinars, setWebinars] = useState<WebinarWithPlan[]>([]);
  const [classes, setClasses] = useState<ClassWithPlan[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const { toast } = useToast();

  useEffect(() => {
    const fetchEvents = async () => {
      setIsLoading(true);
      setError(null);
      try {
        const [consultationsRes, subscriptionsRes, webinarsRes, classesRes] =
          await Promise.all([
            fetch(
              `/api/events/consultations?consulteeProfileId=${consulteeProfileId}`,
            ),
            fetch(
              `/api/events/subscriptions?consulteeProfileId=${consulteeProfileId}`,
            ),
            fetch(
              `/api/events/webinars?consulteeProfileId=${consulteeProfileId}`,
            ),
            fetch(
              `/api/events/classes?consulteeProfileId=${consulteeProfileId}`,
            ),
          ]);

        if (
          !consultationsRes.ok ||
          !subscriptionsRes.ok ||
          !webinarsRes.ok ||
          !classesRes.ok
        ) {
          throw new Error(`Failed to fetch events`);
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

    if (consulteeProfileId) {
      fetchEvents();
    }
  }, [consulteeProfileId, toast]);

  return { consultations, subscriptions, webinars, classes, isLoading, error };
};

// Hook for fetching events by consultee
export const useEventsByConsultee = (consulteeProfileId: string) => {
  const [consultations, setConsultations] = useState<ConsultationWithPlan[]>([]);
  const [subscriptions, setSubscriptions] = useState<SubscriptionWithPlan[]>([]);
  const [webinars, setWebinars] = useState<WebinarWithPlan[]>([]);
  const [classes, setClasses] = useState<ClassWithPlan[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const { toast } = useToast();

  useEffect(() => {
    const fetchEvents = async () => {
      setIsLoading(true);
      setError(null);
      try {
        const [consultationsRes, subscriptionsRes, webinarsRes, classesRes] =
          await Promise.all([
            fetch(
              `/api/events/consultations?consulteeProfileId=${consulteeProfileId}`,
            ),
            fetch(
              `/api/events/subscriptions?consulteeProfileId=${consulteeProfileId}`,
            ),
            fetch(
              `/api/events/webinars?consulteeProfileId=${consulteeProfileId}`,
            ),
            fetch(
              `/api/events/classes?consulteeProfileId=${consulteeProfileId}`,
            ),
          ]);

        if (
          !consultationsRes.ok ||
          !subscriptionsRes.ok ||
          !webinarsRes.ok ||
          !classesRes.ok
        ) {
          throw new Error(`Failed to fetch events`);
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

    if (consulteeProfileId) {
      fetchEvents();
    }
  }, [consulteeProfileId, toast]);

  return { consultations, subscriptions, webinars, classes, isLoading, error };
};

// Hook for fetching events by consultant
export const useEventsByConsultant = (consultantProfileId: string) => {
  const [consultations, setConsultations] = useState<ConsultationWithPlan[]>([]);
  const [subscriptions, setSubscriptions] = useState<SubscriptionWithPlan[]>([]);
  const [webinars, setWebinars] = useState<WebinarWithPlan[]>([]);
  const [classes, setClasses] = useState<ClassWithPlan[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const { toast } = useToast();

  useEffect(() => {
    const fetchEvents = async () => {
      setIsLoading(true);
      setError(null);
      try {
        const [consultationsRes, subscriptionsRes, webinarsRes, classesRes] =
          await Promise.all([
            fetch(
              `/api/events/consultations?consultantProfileId=${consultantProfileId}`,
            ),
            fetch(
              `/api/events/subscriptions?consultantProfileId=${consultantProfileId}`,
            ),
            fetch(
              `/api/events/webinars?consultantProfileId=${consultantProfileId}`,
            ),
            fetch(
              `/api/events/classes?consultantProfileId=${consultantProfileId}`,
            ),
          ]);

        if (
          !consultationsRes.ok ||
          !subscriptionsRes.ok ||
          !webinarsRes.ok ||
          !classesRes.ok
        ) {
          throw new Error(`Failed to fetch events`);
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

    if (consultantProfileId) {
      fetchEvents();
    }
  }, [consultantProfileId, toast]);

  return { consultations, subscriptions, webinars, classes, isLoading, error };
};

// Hook for fetching events by user (detects role and fetches accordingly)
export const useEventsByUser = (userId: string) => {
  const [consultations, setConsultations] = useState<ConsultationWithPlan[]>([]);
  const [subscriptions, setSubscriptions] = useState<SubscriptionWithPlan[]>([]);
  const [webinars, setWebinars] = useState<WebinarWithPlan[]>([]);
  const [classes, setClasses] = useState<ClassWithPlan[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const { toast } = useToast();

  useEffect(() => {
    const fetchUserDetails = async () => {
      try {
        const response = await fetch(`/api/user/${userId}`);
        if (!response.ok) {
          throw new Error("Failed to fetch user details");
        }
        
        const userData = await response.json();
        return userData.data;
      } catch (err: any) {
        console.error("Error fetching user details:", err);
        toast({
          title: "Error fetching user details",
          description: err.message,
          variant: "destructive",
        });
        return null;
      }
    };

    const fetchEvents = async () => {
      setIsLoading(true);
      setError(null);
      
      try {
        const userDetails = await fetchUserDetails();
        if (!userDetails) {
          throw new Error("User details not found");
        }
        console.log("userDetails", userDetails);
        let queryParam = "";
        if (userDetails.role === "CONSULTANT" && userDetails.consultantProfile?.id) {
          queryParam = `consultantProfileId=${userDetails.consultantProfile.id}`;
        } else if (userDetails.role === "CONSULTEE" && userDetails.consulteeProfile?.id) {
          queryParam = `consulteeProfileId=${userDetails.consulteeProfile.id}`;
        } else {
          // If role or profile is not found, just use empty arrays for now
          console.warn("User role or profile not found, using empty arrays");
          setConsultations([]);
          setSubscriptions([]);
          setWebinars([]);
          setClasses([]);
          setIsLoading(false);
          return;
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
          throw new Error(`Failed to fetch events`);
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

    if (userId) {
      fetchEvents();
    }
  }, [userId, toast]);

  return { consultations, subscriptions, webinars, classes, isLoading, error };
};
