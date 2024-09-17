import { useState, useEffect, useCallback } from 'react';
import { SlotOfAvailability, NewSlot } from '../utils';
import { toast } from "@/components/ui/use-toast";

export const useSlots = () => {
  const [slots, setSlots] = useState<SlotOfAvailability[]>([]);

  const fetchSlots = useCallback(async () => {
    try {
      const response = await fetch('/api/slots');
      const data = await response.json();
      setSlots(data.map((slot: SlotOfAvailability) => ({
        ...slot,
        slotStartTimeInUTC: new Date(slot.slotStartTimeInUTC),
        slotEndTimeInUTC: new Date(slot.slotEndTimeInUTC),
      })));
    } catch (error) {
      console.error('Error fetching slots:', error);
      toast({
        title: "Error",
        description: "Failed to fetch slots. Please try again.",
        variant: "destructive",
      });
    }
  }, []);

  useEffect(() => {
    fetchSlots();
  }, [fetchSlots]);

  const addSlot = useCallback(async (newSlot: NewSlot) => {
    try {
      const slotToAdd = newSlot.type === 'weekly'
        ? {
            dayOfWeekforStartTimeInUTC: newSlot.dayOfWeekforStartTimeInUTC,
            dayOfWeekforEndTimeInUTC: newSlot.dayOfWeekforEndTimeInUTC,
            slotStartTimeInUTC: newSlot.slotStartTimeInUTC,
            slotEndTimeInUTC: newSlot.slotEndTimeInUTC,
          }
        : {
            slotStartTimeInUTC: newSlot.slotStartTimeInUTC,
            slotEndTimeInUTC: newSlot.slotEndTimeInUTC,
          };

      const response = await fetch('/api/slots', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(slotToAdd),
      });
      const data = await response.json();
      setSlots(prevSlots => [...prevSlots, {
        ...data,
        slotStartTimeInUTC: new Date(data.slotStartTimeInUTC),
        slotEndTimeInUTC: new Date(data.slotEndTimeInUTC),
      }]);
      return data;
    } catch (error) {
      console.error('Error adding slot:', error);
      throw error;
    }
  }, []);

  return { slots, addSlot };
};