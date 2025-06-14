import { TAppointment } from "@/types/appointment";
import { AppointmentsType } from "@prisma/client";
import {
    ConsultantApiResponse,
    ConsultationApiResponse,
    SubscriptionApiResponse,
} from "../types";
import { Request, calculateSubscriptionSlots, fetchDataFromApi } from "../utils";

/**
 * Fetch conflicting sessions data for consultations and subscriptions
 */
export async function fetchConflictingSessionsData(consultantId: string) {
  const endpoints = [
    `/api/events/consultations?consultantProfileId=${consultantId}&status=APPROVED`,
    `/api/events/subscriptions?consultantProfileId=${consultantId}&status=APPROVED`,
    `/api/slots/appointments?consultantProfileId=${consultantId}&consultationStatus=APPROVED&subscriptionStatus=APPROVED&webinarStatus=APPROVED&classStatus=APPROVED`,
    `/api/user/consultants/${consultantId}`,
  ];

  const [
    consultationsResult,
    subscriptionsResult,
    appointmentsResult,
    consultantResult,
  ] = await Promise.all([
    fetchDataFromApi<ConsultationApiResponse[]>(endpoints[0]),
    fetchDataFromApi<SubscriptionApiResponse[]>(endpoints[1]),
    fetchDataFromApi<TAppointment[]>(endpoints[2]),
    fetchDataFromApi<ConsultantApiResponse>(endpoints[3]),
  ]);

  const results = [
    consultationsResult,
    subscriptionsResult,
    appointmentsResult,
    consultantResult,
  ];

  // Check for errors
  for (const result of results) {
    if (!result.ok && result.error) {
      return { ok: false, error: result.error, data: null };
    }
  }

  return {
    ok: true,
    error: null,
    data: {
      consultations: consultationsResult.data,
      subscriptions: subscriptionsResult.data,
      appointments: appointmentsResult.data,
      consultant: consultantResult.data,
    },
  };
}

/**
 * Check if two time slots overlap
 */
function doSlotsOverlap(
  slot1Start: string | Date, 
  slot1End: string | Date, 
  slot2Start: string | Date, 
  slot2End: string | Date
): boolean {
  const start1 = slot1Start instanceof Date ? slot1Start : new Date(slot1Start);
  const end1 = slot1End instanceof Date ? slot1End : new Date(slot1End);
  const start2 = slot2Start instanceof Date ? slot2Start : new Date(slot2Start);
  const end2 = slot2End instanceof Date ? slot2End : new Date(slot2End);
  
  return start1.getTime() < end2.getTime() && start2.getTime() < end1.getTime();
}

/**
 * Convert slot time to string for consistent handling
 */
function slotTimeToString(time: string | Date): string {
  return time instanceof Date ? time.toISOString() : time;
}

/**
 * Detect conflicting sessions from approved consultations and subscriptions
 */
export function detectConflictingSessions(
  consultations: ConsultationApiResponse[],
  subscriptions: SubscriptionApiResponse[],
  appointments: TAppointment[]
): Request[] {
  const conflictingRequests: Request[] = [];
  
  // Create a map of all appointment slots for quick lookup
  const appointmentSlots = new Map<string, { 
    start: string | Date; 
    end: string | Date; 
    appointmentId: string; 
    type: string 
  }[]>();
  
  appointments.forEach(appointment => {
    appointment.slotsOfAppointment?.forEach(slot => {
      const slotKey = slotTimeToString(slot.slotStartTimeInUTC);
      if (!appointmentSlots.has(slotKey)) {
        appointmentSlots.set(slotKey, []);
      }
      appointmentSlots.get(slotKey)!.push({
        start: slot.slotStartTimeInUTC,
        end: slot.slotEndTimeInUTC,
        appointmentId: appointment.id,
        type: appointment.appointmentType
      });
    });
  });

  // Check consultations for conflicts
  consultations.forEach(consultation => {
    if (consultation.appointment?.slotsOfAppointment) {
      let hasConflict = false;
      
      consultation.appointment.slotsOfAppointment.forEach(slot => {
        const slotKey = slotTimeToString(slot.slotStartTimeInUTC);
        const overlappingSlots = appointmentSlots.get(slotKey) || [];
        
        // Check if there are multiple appointments in the same time slot
        if (overlappingSlots.length > 1) {
          hasConflict = true;
        }
        
        // Also check for overlapping with different start times
        appointmentSlots.forEach((slots, startTime) => {
          if (startTime !== slotKey) {
            slots.forEach(otherSlot => {
              if (doSlotsOverlap(
                slot.slotStartTimeInUTC, 
                slot.slotEndTimeInUTC, 
                otherSlot.start, 
                otherSlot.end
              )) {
                hasConflict = true;
              }
            });
          }
        });
      });
      
      if (hasConflict) {
        conflictingRequests.push({
          id: consultation.id,
          type: AppointmentsType.CONSULTATION,
          title: consultation.consultationPlan?.title || "Untitled Plan",
          requestedBy: consultation.requestedBy,
          requestedAt: consultation.requestedAt,
          status: consultation.requestStatus,
          requiredSlots: 1,
          allocatedSlots: consultation.appointment.slotsOfAppointment.map(slot => 
            slotTimeToString(slot.slotStartTimeInUTC)
          ),
        });
      }
    }
  });

  // Check subscriptions for conflicts
  subscriptions.forEach(subscription => {
    if (subscription.appointments) {
      let hasConflict = false;
      const allSlots: string[] = [];
      
      subscription.appointments.forEach(appointment => {
        appointment.slotsOfAppointment?.forEach(slot => {
          const slotKey = slotTimeToString(slot.slotStartTimeInUTC);
          allSlots.push(slotKey);
          
          const overlappingSlots = appointmentSlots.get(slotKey) || [];
          
          // Check if there are multiple appointments in the same time slot
          if (overlappingSlots.length > 1) {
            hasConflict = true;
          }
          
          // Also check for overlapping with different start times
          appointmentSlots.forEach((slots, startTime) => {
            if (startTime !== slotKey) {
              slots.forEach(otherSlot => {
                if (doSlotsOverlap(
                  slot.slotStartTimeInUTC, 
                  slot.slotEndTimeInUTC, 
                  otherSlot.start, 
                  otherSlot.end
                )) {
                  hasConflict = true;
                }
              });
            }
          });
        });
      });
      
      if (hasConflict) {
        const callsPerWeek = subscription.subscriptionPlan?.callsPerWeek ?? 1;
        const durationInMonths = subscription.subscriptionPlan?.durationInMonths ?? 1;
        const requiredSlots = calculateSubscriptionSlots(callsPerWeek, durationInMonths);
        
        conflictingRequests.push({
          id: subscription.id,
          type: AppointmentsType.SUBSCRIPTION,
          title: subscription.subscriptionPlan?.title || "Untitled Plan",
          requestedBy: subscription.requestedBy,
          requestedAt: subscription.requestedAt,
          status: subscription.requestStatus,
          requiredSlots,
          allocatedSlots: allSlots,
        });
      }
    }
  });

  return conflictingRequests;
}
