import { useState, useEffect } from 'react';
import { useToast } from "@/components/ui/use-toast";
import { Consultation, Webinar, Class, Subscription } from '@prisma/client';

export const useEvents = (consulteeId: string) => {
  const [consultations, setConsultations] = useState<Consultation[]>([]);
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
  const [webinars, setWebinars] = useState<Webinar[]>([]);
  const [classes, setClasses] = useState<Class[]>([]);
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