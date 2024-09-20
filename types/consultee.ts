import { Prisma } from '@prisma/client';

/**
 * Represents a ConsulteeProfile with specific included relations.
 * This type uses Prisma's generated types to ensure type safety and consistency with the database schema.
 * 
 * @typedef {Object} TConsulteeProfile
 * @property {Object} user - The user associated with this consultee profile.
 * @property {Object[]} consultationRequests - Consultation requests made by the consultee.
 * @property {Object[]} subscriptionRequests - Subscription requests made by the consultee.
 * @property {Object[]} slotsOfAppointment - Appointment slots booked by the consultee.
 * @property {Object[]} consultantReviews - Reviews given by the consultee to consultants.
 */
export type TConsulteeProfile = Prisma.ConsulteeProfileGetPayload<{
  include: {
    user: true,
    consultationRequests: true,
    subscriptionRequests: true,
    slotsOfAppointment: true,
    consultantReviews: true,
  }
}>;

// By using Prisma.ConsulteeProfileGetPayload, we ensure that the type
// exactly matches what Prisma will return when querying a ConsulteeProfile
// with these specific relations included. This helps prevent type mismatches
// and provides better autocomplete and type checking in our application.