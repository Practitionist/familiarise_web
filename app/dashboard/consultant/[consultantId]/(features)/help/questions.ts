export interface FAQ {
  id: string;
  question: string;
  answer: string;
  category: string;
}

export const faqs: FAQ[] = [
  // Profile & Account
  {
    id: "profile-setup",
    question: "How do I set up my consultant profile?",
    answer:
      "Your consultant profile includes your qualifications, specialization, experience, and domain expertise. You can add these details along with your availability schedule and service offerings.",
    category: "Profile",
  },
  {
    id: "domain-expertise",
    question: "How can I specify my domain expertise?",
    answer:
      "You can select your primary domain and multiple sub-domains, along with relevant tags to showcase your expertise areas. This helps consultees find you more easily.",
    category: "Profile",
  },

  // Scheduling
  {
    id: "availability-setup",
    question: "How do I set my availability?",
    answer:
      "You can choose between weekly recurring slots or custom time slots. For weekly slots, set your available days and times. For custom slots, specify individual date-time slots.",
    category: "Scheduling",
  },
  {
    id: "timezone-handling",
    question: "How are different time zones handled?",
    answer:
      "All slots are stored in UTC. The system automatically converts times to the consultee's timezone when they view your availability.",
    category: "Scheduling",
  },

  // Services
  {
    id: "service-types",
    question: "What types of services can I offer?",
    answer:
      "You can offer four types of services: one-on-one consultations, subscription-based mentoring, webinars for larger groups, and structured classes.",
    category: "Services",
  },
  {
    id: "consultation-setup",
    question: "How do I set up consultation plans?",
    answer:
      "Create consultation plans by specifying duration, price, language, level, prerequisites, and learning outcomes. You can create multiple plans for different needs.",
    category: "Services",
  },

  // Meetings
  {
    id: "meeting-platforms",
    question: "What meeting platforms are supported?",
    answer:
      "We support multiple platforms including Zoom, Google Meet, Microsoft Teams, and our built-in streaming solution. You can also use a custom platform if needed.",
    category: "Meetings",
  },
  {
    id: "recording-feature",
    question: "Can I record sessions?",
    answer:
      "Recording is available for webinars and classes. The recordings are stored securely and can be accessed by participants later.",
    category: "Meetings",
  },

  // Payments
  {
    id: "payment-methods",
    question: "What payment methods are supported?",
    answer:
      "We support multiple payment gateways including Stripe, Razorpay, and card payments. Payments are securely processed and automatically tracked.",
    category: "Payments",
  },
  {
    id: "discount-codes",
    question: "Can I offer discounts?",
    answer:
      "Yes, you can create discount codes with either percentage-based or fixed-amount discounts for your services.",
    category: "Payments",
  },
];

// Helper function to get FAQs by category
export function getFAQsByCategory(category: string): FAQ[] {
  return faqs.filter((faq) => faq.category === category);
}

// Helper function to search FAQs
export function searchFAQs(query: string): FAQ[] {
  const lowercaseQuery = query.toLowerCase();
  return faqs.filter(
    (faq) =>
      faq.question.toLowerCase().includes(lowercaseQuery) ||
      faq.answer.toLowerCase().includes(lowercaseQuery),
  );
}
