import { useState, useEffect } from 'react';
import { useToast } from "@/components/ui/use-toast";
import { TAppointment } from '@/types/appointment';

export const useAppointments = (consulteeId: string) => {
  const [appointments, setAppointments] = useState<TAppointment[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const { toast } = useToast();

  useEffect(() => {
    const fetchAppointments = async () => {
      setIsLoading(true);
      setError(null);
      try {
        const response = await fetch(`/api/slots/appointments?consulteeId=${consulteeId}`);
        if (!response.ok) {
          throw new Error(`Failed to fetch appointments: ${response.statusText}`);
        }
        const data = await response.json();
        setAppointments(data);
      } catch (err: any) {
        console.error("Error fetching appointments:", err);
        setError(err);
        toast({
          title: "Error fetching appointments",
          description: err.message,
          variant: "destructive",
        });
      } finally {
        setIsLoading(false);
      }
    };

    if (consulteeId) {
      fetchAppointments();
    }
  }, [consulteeId, toast]);

  return { appointments, isLoading, error };
};