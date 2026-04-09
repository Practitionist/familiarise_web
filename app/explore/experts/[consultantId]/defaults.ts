export interface PricingOption {
  /**
   * Backing plan id. Required for runtime options built from real
   * ConsultationPlan / SubscriptionPlan rows so tabs stay uniquely keyed and
   * the booking handlers can book the exact plan the user picked. The static
   * defaults below omit it — that's OK since they're only used as pure display
   * placeholders before real data loads.
   */
  id?: string;
  title: string;
  description: string;
  price: number;
  priceCurrency: string; // Currency code (e.g., "INR", "USD")
  duration: string;
  durationInHours?: number; // For consultation plans
  durationInMonths?: number; // For subscription plans
  totalHours?: number; // Total hours of service included
  totalSessions?: number; // Total number of sessions
  callsPerWeek?: number; // Calls per week for subscriptions
  sessionDurationInHours?: number; // Duration of each session
  features?: string[];
}

export const defaultConsultationOptions: PricingOption[] = [
  {
    title: "One Hour",
    description: "Get a quick consultation",
    price: 99,
    priceCurrency: "INR",
    duration: "1 hour",
  },
  {
    title: "Two Hour",
    description: "Dive deeper into your needs",
    price: 199,
    priceCurrency: "INR",
    duration: "2 hours",
  },
  {
    title: "Three Hour",
    description: "Comprehensive consultation",
    price: 299,
    priceCurrency: "INR",
    duration: "3 hours",
  },
];

export const defaultSubscriptionOptions: PricingOption[] = [
  {
    title: "One Month Subscription",
    description: "Get access to our full suite of services for one month.",
    price: 49,
    priceCurrency: "INR",
    duration: "1 month",
    features: [
      "Unlimited consultations",
      "Priority support",
      "Access to all tools and resources",
    ],
  },
  {
    title: "Three Month Subscription",
    description: "Get access to our full suite of services for three months.",
    price: 129,
    priceCurrency: "INR",
    duration: "3 months",
    features: [
      "Unlimited consultations",
      "Priority support",
      "Access to all tools and resources",
      "10% discount on all services",
    ],
  },
  {
    title: "Six Month Subscription",
    description: "Get access to our full suite of services for six months.",
    price: 249,
    priceCurrency: "INR",
    duration: "6 months",
    features: [
      "Unlimited consultations",
      "Priority support",
      "Access to all tools and resources",
      "15% discount on all services",
    ],
  },
];
