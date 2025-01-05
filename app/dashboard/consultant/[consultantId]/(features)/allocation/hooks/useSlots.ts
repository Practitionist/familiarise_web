import { useState, useCallback } from "react";
import { Slot, NewSlot } from "../utils";

export function useSlots() {
  const [slots, setSlots] = useState<Slot[]>([]);

  const addSlot = useCallback(async (newSlot: NewSlot) => {
    // In a real app, this would make an API call
    const slot: Slot = {
      id: Math.random().toString(36).substring(7),
      ...newSlot,
      isBooked: false,
    };

    setSlots((prevSlots) => [...prevSlots, slot]);
  }, []);

  const removeSlot = useCallback((slotId: string) => {
    setSlots((prevSlots) => prevSlots.filter((slot) => slot.id !== slotId));
  }, []);

  const updateSlot = useCallback((slotId: string, updates: Partial<Slot>) => {
    setSlots((prevSlots) =>
      prevSlots.map((slot) =>
        slot.id === slotId ? { ...slot, ...updates } : slot,
      ),
    );
  }, []);

  return {
    slots,
    addSlot,
    removeSlot,
    updateSlot,
  };
}
