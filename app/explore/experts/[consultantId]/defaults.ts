export interface PricingOption {
  title: string;
  description: string;
  price: number;
  duration: string;
  features?: string[];
}

export const defaultConsultationOptions: PricingOption[] = [
  {
    title: "One Hour",
    description: "Get a quick consultation",
    price: 99,
    duration: "1 hour",
  },
  {
    title: "Two Hour",
    description: "Dive deeper into your needs",
    price: 199,
    duration: "2 hours",
  },
  {
    title: "Three Hour",
    description: "Comprehensive consultation",
    price: 299,
    duration: "3 hours",
  },
];

export const defaultSubscriptionOptions: PricingOption[] = [
  {
    title: "One Month Subscription",
    description: "Get access to our full suite of services for one month.",
    price: 49,
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
    duration: "6 months",
    features: [
      "Unlimited consultations",
      "Priority support",
      "Access to all tools and resources",
      "15% discount on all services",
    ],
  },
];
