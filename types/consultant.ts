import { Prisma } from "@prisma/client";

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
    user: true;
    domain: true;
    subDomains: true;
    tags: true;
    slotsOfAvailabilityWeekly: true;
    slotsOfAvailabilityCustom: true;
    consultationPlans: true;
    subscriptionPlans: {
      include: {
        subscriptionContents: true;
      };
    };
    webinarPlans: true;
    classPlans: true;
    reviews: true;
  };
}>;

/**
 * Data shape for consultant cards in public listings.
 * Used by FeaturedExperts, ExpertRow, ExpertMiniCard, ConsultantCard,
 * and FeaturedExpertsSection. Works with both server (lib/data/) and
 * client (useConsultants hook) data sources via structural typing.
 */
export interface IConsultantCardData {
  id: string;
  rating: number;
  headline: string | null;
  experience: number | null;
  description: string | null;
  createdAt: Date;
  isVerified?: boolean;
  user: {
    id: string;
    name: string;
    image: string | null;
    profileDisplayImage?: string | null;
    email?: string;
    workExperiences?: Array<{
      company: string;
      companyDomain: string | null;
      isCurrent: boolean;
    }>;
  };
  languages?: string[];
  domain: { id: string; name: string } | null;
  subDomains: { id: string; name: string }[];
  tags: { id: string; name: string }[];
  reviews?: { rating: number }[];
  subscriptionPlans?: Array<{
    id: string;
    title: string;
    price: number;
    priceCurrency: string;
    durationInMonths: number;
    callsPerWeek: number | null;
    emailSupport: string | null;
    totalSessions: number | null;
  }>;
}

/**
 * Data shape for the expert detail page.
 * Includes plans and slots for booking flow, but NOT reviews
 * (reviews are fetched separately and passed as a distinct prop).
 */
export type TConsultantDetailData = Prisma.ConsultantProfileGetPayload<{
  include: {
    user: {
      select: {
        id: true;
        name: true;
        image: true;
        profileDisplayImage: true;
        bio: true;
        city: true;
        country: true;
        linkedinUrl: true;
        timezone: true;
        workExperiences: true;
        education: true;
        certifications: true;
      };
    };
    domain: true;
    subDomains: true;
    tags: true;
    slotsOfAvailabilityWeekly: true;
    slotsOfAvailabilityCustom: true;
    consultationPlans: true;
    subscriptionPlans: { include: { subscriptionContents: true } };
    webinarPlans: true;
    classPlans: true;
  };
}>;
