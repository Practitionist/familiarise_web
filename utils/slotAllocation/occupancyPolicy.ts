/**
 * Centralized occupancy policy for slot conflict detection.
 *
 * FIX Bug #15: Different services used different status filters for determining
 * occupied slots, causing inconsistent booking behavior. This module defines
 * the canonical status sets that all services must use.
 *
 * Policy: A slot is "occupied" if the parent event is in an active state
 * (not yet completed, cancelled, rejected, or expired).
 */

import { AppointmentStatus, TrialSessionStatus, Prisma } from "@prisma/client";

/**
 * Consultation/Subscription statuses that count as "slot occupied"
 * These are active booking states where the slot should block future availability.
 *
 * - PENDING: User submitted, awaiting consultant approval (tentative hold)
 * - APPROVED: Consultant approved (confirmed)
 * - APPROVED_PENDING_PAYMENT: Approved but payment not yet completed
 * - SCHEDULED: Fully scheduled and confirmed
 */
export const OCCUPIED_REQUEST_STATUSES: AppointmentStatus[] = [
  AppointmentStatus.PENDING,
  AppointmentStatus.APPROVED,
  AppointmentStatus.APPROVED_PENDING_PAYMENT,
  AppointmentStatus.SCHEDULED,
];

/**
 * Webinar/Class statuses that count as "slot occupied"
 * - SCHEDULED: Event is scheduled (confirmed)
 * - IN_PROGRESS: Event is currently happening
 */
export const OCCUPIED_EVENT_STATUSES = ["SCHEDULED", "IN_PROGRESS"] as const;

/**
 * Build a Prisma OR clause for filtering appointments by occupied status.
 * Use this in any query that needs to determine slot occupancy/conflicts.
 *
 * @param consultantProfileId - Optional consultant profile ID to scope the query
 * @returns Prisma OR clause array for appointment filtering
 */
export function buildOccupiedAppointmentFilter(
  consultantProfileId?: string,
): Prisma.AppointmentWhereInput[] {
  const filters: Prisma.AppointmentWhereInput[] = [
    {
      consultation: {
        ...(consultantProfileId
          ? { consultationPlan: { consultantProfileId } }
          : {}),
        status: { in: OCCUPIED_REQUEST_STATUSES },
      },
    },
    {
      subscription: {
        ...(consultantProfileId
          ? { subscriptionPlan: { consultantProfileId } }
          : {}),
        status: { in: OCCUPIED_REQUEST_STATUSES },
      },
    },
    {
      webinar: {
        ...(consultantProfileId
          ? { webinarPlan: { consultantProfileId } }
          : {}),
        status: { in: [...OCCUPIED_EVENT_STATUSES] },
      },
    },
    {
      class: {
        ...(consultantProfileId ? { classPlan: { consultantProfileId } } : {}),
        status: { in: [...OCCUPIED_EVENT_STATUSES] },
      },
    },
  ];

  // Add trial session filter
  if (consultantProfileId) {
    filters.push({
      trialSession: {
        is: {
          consultantProfileId,
          status: TrialSessionStatus.SCHEDULED,
        },
      },
    });
  } else {
    filters.push({
      trialSession: {
        is: {
          status: TrialSessionStatus.SCHEDULED,
        },
      },
    });
  }

  return filters;
}
