export interface PricingOption {
  title: string;
  description: string;
  price: number;
  duration: string;
  features?: string[];
}

export const defaultConsultationOptions: PricingOption[] = [
  {
    title: "1 hour",
    description: "Basic",
    price: 99,
    duration: "1 hour",
  },
  {
    title: "2 hours",
    description: "Extended",
    price: 199,
    duration: "2 hours",
  },
  {
    title: "4 hours",
    description: "Comprehensive",
    price: 299,
    duration: "4 hours",
  },
];

export const defaultSubscriptionOptions: PricingOption[] = [
  {
    title: "1 month",
    description: "Basic",
    price: 49,
    duration: "1 month",
    features: [
      "Unlimited consultations",
      "Priority support",
      "Access to all tools and resources",
    ],
  },
  {
    title: "2 months",
    description: "Extended",
    price: 129,
    duration: "2 months",
    features: [
      "Unlimited consultations",
      "Priority support",
      "Access to all tools and resources",
      "10% discount on all services",
    ],
  },
  {
    title: "4 months",
    description: "Comprehensive",
    price: 249,
    duration: "4 months",
    features: [
      "Unlimited consultations",
      "Priority support",
      "Access to all tools and resources",
      "15% discount on all services",
    ],
  },
];
