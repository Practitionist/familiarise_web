import { useState, useEffect } from 'react';
import { useToast } from "@/components/ui/use-toast";
import { Consultation, Webinar, Class, Subscription, ConsultationPlan, SubscriptionPlan, WebinarPlan, ClassPlan } from '@prisma/client';

export type ConsultationWithPlan = Consultation & { consultationPlan: ConsultationPlan };
export type SubscriptionWithPlan = Subscription & { plan: SubscriptionPlan };
export type WebinarWithPlan = Webinar & { webinarPlan: WebinarPlan };
export type ClassWithPlan = Class & { classPlan: ClassPlan };

export const useEvents = (consulteeId: string) => {
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
        const [consultationsRes, subscriptionsRes, webinarsRes, classesRes] = await Promise.all([
          fetch(`/api/events/consultations?consulteeId=${consulteeId}`),
          fetch(`/api/events/subscriptions?consulteeId=${consulteeId}`),
          fetch(`/api/events/webinars?consulteeId=${consulteeId}`),
          fetch(`/api/events/classes?consulteeId=${consulteeId}`)
        ]);

        if (!consultationsRes.ok || !subscriptionsRes.ok || !webinarsRes.ok || !classesRes.ok) {
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

    if (consulteeId) {
      fetchEvents();
    }
  }, [consulteeId, toast]);

  return { consultations, subscriptions, webinars, classes, isLoading, error };
};
