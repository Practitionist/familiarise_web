interface SlotType {
  startTime: string;
  endTime: string;
  isValid: boolean;
  errorMessage?: string;
}

// Configuration constants
const VALIDATION_CONFIG = {
  MIN_DURATION_MINUTES: 30,
  MAX_DURATION_MINUTES: 12 * 60, // 12 hours max
  BUFFER_MINUTES: 15,
  TIME_INCREMENT_MINUTES: 15,
  SESSION_INCREMENT_MINUTES: 30,
} as const;

// Helper function to convert HH:MM to minutes
const getMinutes = (time: string): number | null => {
  if (!time || typeof time !== 'string') return null;
  const [hours, minutes] = time.split(":").map(Number);
  return !isNaN(hours) && !isNaN(minutes) && hours >= 0 && hours < 24 && minutes >= 0 && minutes < 60 
    ? hours * 60 + minutes 
    : null;
};

// Helper to check if a slot spans midnight
const isOvernightSlot = (startMinutes: number, endMinutes: number): boolean => {
  return endMinutes <= startMinutes;
};

// Calculate slot duration handling overnight slots
const calculateSlotDuration = (startMinutes: number, endMinutes: number): number => {
  return isOvernightSlot(startMinutes, endMinutes)
    ? (24 * 60) - startMinutes + endMinutes
    : endMinutes - startMinutes;
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

// Validate basic time range requirements
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

  // Same start and end time is invalid
  if (startMinutes === endMinutes) {
    return false;
  }

  const duration = calculateSlotDuration(startMinutes, endMinutes);
  
  // Validate duration constraints
  return duration >= VALIDATION_CONFIG.MIN_DURATION_MINUTES && 
         duration <= VALIDATION_CONFIG.MAX_DURATION_MINUTES;
};

// Check if time follows required increments
const validateTimeIncrements = (startMinutes: number, endMinutes: number): string | null => {
  if (startMinutes % VALIDATION_CONFIG.TIME_INCREMENT_MINUTES !== 0 || 
      endMinutes % VALIDATION_CONFIG.TIME_INCREMENT_MINUTES !== 0) {
    return `Times must be in multiples of ${VALIDATION_CONFIG.TIME_INCREMENT_MINUTES} minutes`;
  }
  
  const duration = calculateSlotDuration(startMinutes, endMinutes);
  if (duration % VALIDATION_CONFIG.SESSION_INCREMENT_MINUTES !== 0) {
    return `Session duration must be in multiples of ${VALIDATION_CONFIG.SESSION_INCREMENT_MINUTES} minutes`;
  }
  
  return null;
};

// Check if duration meets requirements
const validateDuration = (startMinutes: number, endMinutes: number): string | null => {
  const duration = calculateSlotDuration(startMinutes, endMinutes);
  
  if (duration < VALIDATION_CONFIG.MIN_DURATION_MINUTES) {
    return `Session must be at least ${VALIDATION_CONFIG.MIN_DURATION_MINUTES} minutes long`;
  }
  
  if (duration > VALIDATION_CONFIG.MAX_DURATION_MINUTES) {
    return `Session cannot exceed ${VALIDATION_CONFIG.MAX_DURATION_MINUTES / 60} hours`;
  }
  
  return null;
};

// Check for overlaps between two time slots
const checkSlotOverlap = (
  slot1Start: number,
  slot1End: number,
  slot2Start: number, 
  slot2End: number,
): boolean => {
  const slot1IsOvernight = isOvernightSlot(slot1Start, slot1End);
  const slot2IsOvernight = isOvernightSlot(slot2Start, slot2End);
  
  // Convert overnight slots to ranges that can be compared
  const slot1Ranges = slot1IsOvernight 
    ? [[slot1Start, 24 * 60], [0, slot1End]]
    : [[slot1Start, slot1End]];
    
  const slot2Ranges = slot2IsOvernight
    ? [[slot2Start, 24 * 60], [0, slot2End]]
    : [[slot2Start, slot2End]];
  
  // Check if any ranges overlap with buffer
  for (const [start1, end1] of slot1Ranges) {
    for (const [start2, end2] of slot2Ranges) {
      if (!(end1 + VALIDATION_CONFIG.BUFFER_MINUTES <= start2 || 
            start1 >= end2 + VALIDATION_CONFIG.BUFFER_MINUTES)) {
        return true;
      }
    }
  }
  
  return false;
};

// Validate slot against other slots for overlaps
const validateSlotOverlaps = (slot: SlotType, otherSlots: SlotType[]): string | null => {
  const startMinutes = getMinutes(slot.startTime);
  const endMinutes = getMinutes(slot.endTime);
  
  if (startMinutes === null || endMinutes === null) {
    return "Invalid time format";
  }
  
  // Only check against valid slots
  const validSlots = otherSlots.filter(s => s.isValid && s.startTime && s.endTime);
  
  for (const otherSlot of validSlots) {
    const otherStart = getMinutes(otherSlot.startTime);
    const otherEnd = getMinutes(otherSlot.endTime);
    
    if (otherStart === null || otherEnd === null) continue;
    
    if (checkSlotOverlap(startMinutes, endMinutes, otherStart, otherEnd)) {
      return `Must have at least a ${VALIDATION_CONFIG.BUFFER_MINUTES}-minute break between sessions`;
    }
  }
  
  return null;
};

// Main validation function - now much cleaner and modular
export const validateTimeSlot = (
  slot: SlotType,
  otherSlots: SlotType[],
  key: string, 
  setSlots?: React.Dispatch<React.SetStateAction<Record<string, SlotType[]>>>,
  isWeekly: boolean = false,
): SlotType => {
  // Early return for empty slots
  if (!slot.startTime || !slot.endTime) {
    return {
      ...slot,
      isValid: false,
      errorMessage: "Please select both start and end time",
    };
  }

  // Validate basic time range
  if (!isValidTimeRange(slot.startTime, slot.endTime)) {
    return {
      ...slot,
      isValid: false,
      errorMessage: "Invalid time range",
    };
  }

  const startMinutes = getMinutes(slot.startTime)!
  const endMinutes = getMinutes(slot.endTime)!

  // Validate time increments
  const incrementError = validateTimeIncrements(startMinutes, endMinutes);
  if (incrementError) {
    return { ...slot, isValid: false, errorMessage: incrementError };
  }

  // Validate duration
  const durationError = validateDuration(startMinutes, endMinutes);
  if (durationError) {
    return { ...slot, isValid: false, errorMessage: durationError };
  }

  // Check for overlaps
  const overlapError = validateSlotOverlaps(slot, otherSlots);
  if (overlapError) {
    return { ...slot, isValid: false, errorMessage: overlapError };
  }

  // Handle overnight slot splitting if needed
  const isOvernight = isOvernightSlot(startMinutes, endMinutes);
  if (isOvernight && setSlots) {
    handleOvernightSlotSplit(slot, key, isWeekly, setSlots);
    return {
      startTime: slot.startTime,
      endTime: "00:00",
      isValid: true,
      errorMessage: undefined,
    };
  }

  return { ...slot, isValid: true, errorMessage: undefined };
};

// Handle splitting overnight slots into two separate slots
const handleOvernightSlotSplit = (
  slot: SlotType,
  key: string,
  isWeekly: boolean,
  setSlots: React.Dispatch<React.SetStateAction<Record<string, SlotType[]>>>,
): void => {
  const currentDaySlot: SlotType = {
    startTime: slot.startTime,
    endTime: "00:00",
    isValid: true,
  };

  const nextDaySlot: SlotType = {
    startTime: "00:00",
    endTime: slot.endTime,
    isValid: true,
  };

  setSlots((prev) => {
    const nextKey = isWeekly ? getNextDay(key) : getNextDate(key);
    return {
      ...prev,
      [key]: [
        ...(prev[key] || []).filter(
          (s) => !(s.startTime === slot.startTime && s.endTime === slot.endTime),
        ),
        currentDaySlot,
      ],
      [nextKey]: [...(prev[nextKey] || []), nextDaySlot],
    };
  });
};

// Enhanced validation for all slots with detailed feedback
export const validateAllSlots = (
  slots: Record<string, SlotType[]>,
): { isValid: boolean; errors: string[] } => {
  const errors: string[] = [];
  let isValid = true;

  Object.entries(slots).forEach(([day, daySlots]) => {
    daySlots.forEach((slot, index) => {
      if (!slot.isValid && slot.errorMessage) {
        errors.push(`${day} slot ${index + 1}: ${slot.errorMessage}`);
        isValid = false;
      }
    });
  });

  return { isValid, errors };
};

// Quick boolean check for backward compatibility
export const allSlotsValid = (slots: Record<string, SlotType[]>): boolean => {
  return validateAllSlots(slots).isValid;
};

// Get slot statistics for debugging/optimization
export const getSlotStatistics = (slots: Record<string, SlotType[]>) => {
  let totalSlots = 0;
  let validSlots = 0;
  let overnightSlots = 0;
  let totalDuration = 0;

  Object.values(slots).forEach(daySlots => {
    daySlots.forEach(slot => {
      totalSlots++;
      if (slot.isValid) {
        validSlots++;
        const start = getMinutes(slot.startTime);
        const end = getMinutes(slot.endTime);
        if (start !== null && end !== null) {
          if (isOvernightSlot(start, end)) {
            overnightSlots++;
          }
          totalDuration += calculateSlotDuration(start, end);
        }
      }
    });
  });

  return {
    totalSlots,
    validSlots,
    invalidSlots: totalSlots - validSlots,
    overnightSlots,
    totalDurationHours: Math.round(totalDuration / 60 * 100) / 100,
    averageDurationMinutes: validSlots > 0 ? Math.round(totalDuration / validSlots) : 0,
  };
};
