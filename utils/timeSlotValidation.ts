interface SlotType {
  startTime: string;
  endTime: string;
  isValid: boolean;
  errorMessage?: string;
}

const getMinutes = (time: string): number | null => {
  const [hours, minutes] = time.split(":").map(Number);
  return !isNaN(hours) && !isNaN(minutes) ? hours * 60 + minutes : null;
};

const formatMinutesToTime = (minutes: number): string => {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${hours.toString().padStart(2, "0")}:${mins.toString().padStart(2, "0")}`;
};

const getNextDay = (day: string): string => {
  const days = [
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
    "sunday",
  ];
  const currentIndex = days.indexOf(day.toLowerCase());
  return days[(currentIndex + 1) % 7];
};

const getNextDate = (dateString: string): string => {
  const date = new Date(dateString);
  date.setDate(date.getDate() + 1);
  return date.toISOString().split("T")[0];
};

export const isValidTimeRange = (
  startTime: string,
  endTime: string,
): boolean => {
  if (!startTime || !endTime) return false;

  const startMinutes = getMinutes(startTime);
  const endMinutes = getMinutes(endTime);

  if (startMinutes === null || endMinutes === null) {
    return false;
  }

  // Check for 12 AM to 12 AM case
  if (startMinutes === 0 && endMinutes === 0) {
    return false;
  }

  // For overnight slots, add 24 hours to end time
  const totalMinutes =
    endMinutes < startMinutes
      ? 24 * 60 - startMinutes + endMinutes
      : endMinutes - startMinutes;

  // Ensure slot is at least 30 minutes
  return totalMinutes >= 30;
};

export const validateTimeSlot = (
  slot: SlotType,
  otherSlots: SlotType[],
  key: string, // This can be either a day of week or a date string
  setSlots?: React.Dispatch<React.SetStateAction<Record<string, SlotType[]>>>,
  isWeekly: boolean = false,
): SlotType => {
  // First check if it's a valid time range
  if (!isValidTimeRange(slot.startTime, slot.endTime)) {
    return {
      ...slot,
      isValid: false,
      errorMessage:
        slot.startTime === "" || slot.endTime === ""
          ? "Please select both start and end time"
          : "Invalid time range",
    };
  }

  const startMinutes = getMinutes(slot.startTime);
  const endMinutes = getMinutes(slot.endTime);

  if (startMinutes === null || endMinutes === null) {
    return { ...slot, isValid: false, errorMessage: "Invalid time format" };
  }

  // Handle day boundary case
  const isOvernight = endMinutes < startMinutes;
  const adjustedEndMinutes = isOvernight ? endMinutes + 24 * 60 : endMinutes;

  // Basic validation checks
  if (startMinutes % 15 !== 0 || endMinutes % 15 !== 0) {
    return {
      ...slot,
      isValid: false,
      errorMessage: "Times must be in multiples of 15 minutes",
    };
  }

  const duration = adjustedEndMinutes - startMinutes;
  if (duration < 30) {
    return {
      ...slot,
      isValid: false,
      errorMessage: "Session must be at least 30 minutes long",
    };
  }

  if (duration % 30 !== 0) {
    return {
      ...slot,
      isValid: false,
      errorMessage: "Session duration must be in multiples of 30 minutes",
    };
  }

  // Check for overlaps with other slots
  for (const otherSlot of otherSlots) {
    const otherStartMinutes = getMinutes(otherSlot.startTime);
    const otherEndMinutes = getMinutes(otherSlot.endTime);
    if (otherStartMinutes === null || otherEndMinutes === null) continue;

    const otherIsOvernight = otherEndMinutes < otherStartMinutes;
    const adjustedOtherEndMinutes = otherIsOvernight
      ? otherEndMinutes + 24 * 60
      : otherEndMinutes;

    const hasOverlap =
      (startMinutes >= otherStartMinutes &&
        startMinutes < adjustedOtherEndMinutes + 15) ||
      (adjustedEndMinutes > otherStartMinutes - 15 &&
        adjustedEndMinutes <= adjustedOtherEndMinutes) ||
      (startMinutes <= otherStartMinutes &&
        adjustedEndMinutes >= adjustedOtherEndMinutes);

    if (hasOverlap) {
      return {
        ...slot,
        isValid: false,
        errorMessage: "Must have at least a 15-minute break between sessions",
      };
    }
  }

  // If the slot spans multiple days and we have the necessary context to split it
  if (isOvernight && setSlots) {
    // Create slot for current day (up to midnight)
    const currentDaySlot: SlotType = {
      startTime: slot.startTime,
      endTime: "00:00",
      isValid: true,
    };

    // Create slot for next day (from midnight)
    const nextDaySlot: SlotType = {
      startTime: "00:00",
      endTime: slot.endTime,
      isValid: true,
    };

    // Update slots for both days
    setSlots((prev) => {
      const nextKey = isWeekly ? getNextDay(key) : getNextDate(key);
      return {
        ...prev,
        [key]: [
          ...(prev[key] || []).filter(
            (s) => s.startTime !== slot.startTime && s.endTime !== slot.endTime,
          ),
          currentDaySlot,
        ],
        [nextKey]: [...(prev[nextKey] || []), nextDaySlot],
      };
    });

    // Return the current day slot as valid
    return currentDaySlot;
  }

  // If we can't split the slot (no context provided) or it doesn't need splitting
  return { ...slot, isValid: true, errorMessage: undefined };
};

export const validateAllSlots = (
  slots: Record<string, SlotType[]>,
): boolean => {
  return Object.values(slots).every((daySlots) =>
    daySlots.every((slot) => slot.isValid),
  );
};
