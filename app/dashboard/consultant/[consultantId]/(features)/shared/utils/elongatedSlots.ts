import { TimeSlot } from "./calendarUtils";

/**
 * Utility functions for handling elongated slot selections
 * Allows users to select multiple consecutive 30-minute slots to create longer sessions
 */

/**
 * Fetches the required session duration from event plan
 */
export async function fetchSessionDurationFromPlan(
  eventType: "consultation" | "subscription" | "webinar" | "class",
  eventId: string
): Promise<number> {
  try {
    const endpoint = getEventEndpoint(eventType, eventId);
    const response = await fetch(endpoint);
    
    if (!response.ok) {
      throw new Error(`Failed to fetch ${eventType} plan`);
    }
    
    const data = await response.json();
    return extractSessionDuration(eventType, data);
  } catch (error) {
    console.warn(`Failed to fetch session duration for ${eventType}:`, error);
    return getDefaultSessionDuration(eventType);
  }
}

/**
 * Gets the API endpoint for different event types
 */
function getEventEndpoint(eventType: string, eventId: string): string {
  const endpoints = {
    consultation: `/api/events/consultations/${eventId}`,
    subscription: `/api/events/subscriptions/${eventId}`,
    webinar: `/api/events/webinars/${eventId}`,
    class: `/api/events/classes/${eventId}`
  };
  return endpoints[eventType as keyof typeof endpoints];
}

/**
 * Extracts session duration from plan data
 */
function extractSessionDuration(eventType: string, data: any): number {
  switch (eventType) {
    case "consultation":
      return data.consultationPlan?.durationInHours || 1;
    
    case "subscription":
      return data.subscriptionPlan?.sessionDurationInHours || 1;
    
    case "webinar":
      return data.webinarPlan?.durationInHours || 1;
    
    case "class":
      // For classes, calculate average from class contents
      const classContents = data.classPlan?.classContents || [];
      if (classContents.length > 0) {
        const totalHours = classContents.reduce((sum: number, content: any) => sum + content.hoursAllotted, 0);
        return totalHours / classContents.length;
      }
      return 1;
    
    default:
      return 1;
  }
}

/**
 * Gets default session duration fallback
 */
function getDefaultSessionDuration(eventType: string): number {
  const defaults = {
    consultation: 1,    // 1 hour
    subscription: 1,    // 1 hour
    webinar: 1,         // 1 hour
    class: 1            // 1 hour
  };
  return defaults[eventType as keyof typeof defaults] || 1;
}

/**
 * Calculates number of 30-minute slots needed for session duration
 */
export function calculateRequiredSlots30Min(sessionDurationInHours: number): number {
  return Math.ceil(sessionDurationInHours * 2); // 2 slots per hour (30-min each)
}

/**
 * Groups consecutive slots into elongated slot blocks
 */
export function groupConsecutiveSlots(slots: TimeSlot[]): TimeSlot[][] {
  if (slots.length === 0) return [];
  
  // Sort slots by start time
  const sortedSlots = [...slots].sort((a, b) => a.startTime.getTime() - b.startTime.getTime());
  
  const groups: TimeSlot[][] = [];
  let currentGroup: TimeSlot[] = [sortedSlots[0]];
  
  for (let i = 1; i < sortedSlots.length; i++) {
    const currentSlot = sortedSlots[i];
    const lastSlotInGroup = currentGroup[currentGroup.length - 1];
    
    // Check if current slot is consecutive (starts when previous ends)
    const isConsecutive = currentSlot.startTime.getTime() === lastSlotInGroup.endTime.getTime();
    
    if (isConsecutive) {
      currentGroup.push(currentSlot);
    } else {
      groups.push(currentGroup);
      currentGroup = [currentSlot];
    }
  }
  
  groups.push(currentGroup);
  return groups;
}

/**
 * Creates an elongated slot from consecutive slots
 */
export function createElongatedSlot(consecutiveSlots: TimeSlot[]): TimeSlot {
  if (consecutiveSlots.length === 0) {
    throw new Error("Cannot create elongated slot from empty array");
  }
  
  const sortedSlots = [...consecutiveSlots].sort((a, b) => a.startTime.getTime() - b.startTime.getTime());
  
  return {
    startTime: sortedSlots[0].startTime,
    endTime: sortedSlots[sortedSlots.length - 1].endTime,
    isAvailable: sortedSlots.every(slot => slot.isAvailable),
    isBooked: sortedSlots.some(slot => slot.isBooked),
    isPartiallyBooked: sortedSlots.some(slot => slot.isPartiallyBooked),
    isConflicting: sortedSlots.some(slot => slot.isConflicting),
    originalSlot: sortedSlots[0].originalSlot, // Keep reference to first slot
    appointmentDetails: sortedSlots.flatMap(slot => slot.appointmentDetails || [])
  };
}

/**
 * Validates that selected slots form valid elongated sessions
 */
export function validateElongatedSlotSelection(
  selectedSlots: TimeSlot[],
  requiredSessionDurationInHours: number,
  allowPartialSessions: boolean = false
): { isValid: boolean; errorMessage?: string; validGroups: TimeSlot[][] } {
  const groups = groupConsecutiveSlots(selectedSlots);
  const requiredSlots30Min = calculateRequiredSlots30Min(requiredSessionDurationInHours);
  
  const validGroups = groups.filter(group => {
    if (allowPartialSessions) {
      return group.length > 0 && group.length <= requiredSlots30Min;
    }
    return group.length === requiredSlots30Min;
  });
  
  if (validGroups.length === 0) {
    return {
      isValid: false,
      errorMessage: `Please select ${requiredSlots30Min} consecutive 30-minute slots (${requiredSessionDurationInHours} hour${requiredSessionDurationInHours !== 1 ? 's' : ''} total)`,
      validGroups: []
    };
  }
  
  // Check for invalid group sizes
  const invalidGroups = groups.filter(group => !validGroups.includes(group));
  if (invalidGroups.length > 0) {
    return {
      isValid: false,
      errorMessage: `Some selected slots don't form valid ${requiredSessionDurationInHours}-hour sessions. Please select ${requiredSlots30Min} consecutive slots per session.`,
      validGroups
    };
  }
  
  return {
    isValid: true,
    validGroups
  };
}

/**
 * Checks if two time slots are consecutive (second starts when first ends)
 */
export function areConsecutiveSlots(slot1: TimeSlot, slot2: TimeSlot): boolean {
  return slot1.endTime.getTime() === slot2.startTime.getTime();
}

/**
 * Gets visual styling for elongated slot groups
 */
export function getElongatedSlotStyling(
  slotIndex: number,
  groupSize: number
): { borderRadius: string; borderWidth: string } {
  if (groupSize === 1) {
    return { borderRadius: "4px", borderWidth: "2px" };
  }
  
  if (slotIndex === 0) {
    // First slot in group - rounded top
    return { borderRadius: "4px 4px 0 0", borderWidth: "2px 2px 1px 2px" };
  } else if (slotIndex === groupSize - 1) {
    // Last slot in group - rounded bottom
    return { borderRadius: "0 0 4px 4px", borderWidth: "1px 2px 2px 2px" };
  } else {
    // Middle slot in group - no rounding
    return { borderRadius: "0", borderWidth: "1px 2px 1px 2px" };
  }
}

/**
 * Formats elongated slot duration for display
 */
export function formatElongatedSlotDuration(durationInHours: number): string {
  if (durationInHours < 1) {
    const minutes = durationInHours * 60;
    return `${minutes}min`;
  } else if (durationInHours === 1) {
    return "1 hour";
  } else if (durationInHours === Math.floor(durationInHours)) {
    return `${durationInHours} hours`;
  } else {
    const hours = Math.floor(durationInHours);
    const minutes = (durationInHours - hours) * 60;
    return `${hours}h ${minutes}min`;
  }
}

/**
 * Converts elongated slots back to 30-minute slots for API submission
 */
export function convertElongatedSlotsTo30MinSlots(elongatedSlots: TimeSlot[]): string[] {
  const slots30Min: string[] = [];
  
  elongatedSlots.forEach(elongatedSlot => {
    const startTime = new Date(elongatedSlot.startTime);
    const endTime = new Date(elongatedSlot.endTime);
    
    let currentTime = new Date(startTime);
    while (currentTime < endTime) {
      slots30Min.push(currentTime.toISOString());
      currentTime = new Date(currentTime.getTime() + 30 * 60 * 1000); // Add 30 minutes
    }
  });
  
  return slots30Min;
}