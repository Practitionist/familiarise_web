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
  appointment: TAppointment | null;
};

export type WebinarWithPlan = TWebinar & {
  appointment: TAppointment | null;
};

export type ClassWithPlan = TClass & {
  appointment: TAppointment | null;
};

export const useEvents = (consulteeProfileId: string) => {
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
