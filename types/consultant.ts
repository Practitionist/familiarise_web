import { Prisma } from '@prisma/client';

/**
 * Represents a ConsultantProfile with specific included relations.
 * This type uses Prisma's generated types to ensure type safety and consistency with the database schema.
 * 
 * @typedef {Object} TConsultantProfile
 * @property {Object} user - The user associated with this consultant profile.
 * @property {Object[]} slotOfAvailabilityWeekly - Weekly availability slots for recurring schedules.
 * @property {Object[]} slotOfAvailabilityCustom - Custom availability slots for flexible scheduling.
 * @property {Object[]} consultationPlans - Consultation plans offered by the consultant.
 * @property {Object[]} subscriptionPlans - Subscription plans offered by the consultant.
 * @property {Object[]} webinarPlans - Webinar plans offered by the consultant.
 * @property {Object[]} classPlans - Class plans offered by the consultant.
 * @property {Object[]} reviews - Reviews received by the consultant.
 */
export type TConsultantProfile = Prisma.ConsultantProfileGetPayload<{
  include: {
    user: true,
    domain:true,
    subDomains: true,
    slotsOfAvailabilityWeekly: true,
    slotsOfAvailabilityCustom: true,
    consultationPlans: true,
    subscriptionPlans: true,
    webinarPlans: true,
    classPlans: true,
    reviews: true,
  }
}>;

// By using Prisma.ConsultantProfileGetPayload, we ensure that the type
// exactly matches what Prisma will return when querying a ConsultantProfile
// with these specific relations included. This helps prevent type mismatches
// and provides better autocomplete and type checking in our application.
