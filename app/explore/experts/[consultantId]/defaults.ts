export interface PricingOption {
  /** Backing plan id from ConsultationPlan / SubscriptionPlan. Required so
   *  tabs are uniquely keyed and booking handlers can route to the exact plan
   *  the user selected, even when multiple plans share the same duration. */
  id: string;
  /** The expert's own plan title. This is BOTH the card heading and the tab
   *  label — an expert may hold several plans of the same length, and keying
   *  either by duration renders them as indistinguishable rows. */
  title: string;
  description: string;
  price: number;
  priceCurrency: string; // Currency code (e.g., "INR", "USD")
  /** Buyer-facing session length, e.g. "60 mins" / "2 hours". Never interpolate
   *  `durationInHours` into copy; use `formatSessionLength`. */
  duration: string;
  durationInHours?: number; // For consultation plans
  durationInMonths?: number; // For subscription plans
  /** Carries the flagship badge on the card. */
  isFeatured?: boolean;
  totalHours?: number; // Total hours of service included
  totalSessions?: number; // Total number of sessions
  sessionsPerWeek?: number; // Calls per week for subscriptions
  sessionDurationInHours?: number; // Duration of each session
  features?: string[];
}
