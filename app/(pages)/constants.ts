import { COMPANY_INFO } from "@/lib/company";
import {
  STATUTORY_ACK_HOURS,
  STATUTORY_RESOLUTION_DAYS,
} from "@/lib/support/sla";

export const ACK_PROMISE_COPY = `within ${STATUTORY_ACK_HOURS} hours` as const;

export const GRIEVANCE_OFFICER = {
  name: COMPANY_INFO.grievanceOfficerName,
  designation: "Grievance & Nodal Compliance Officer",
  email: COMPANY_INFO.email,
  phone: COMPANY_INFO.phone,
  ackPromise: ACK_PROMISE_COPY,
  resolutionPromise: `within ${STATUTORY_RESOLUTION_DAYS} days`,
} as const;

export const POLICY_DATES = {
  privacyLastUpdated: "November 9, 2026",
  termsLastUpdated: "November 9, 2026",
  refundLastUpdated: "October 28, 2026",
  grievanceLastUpdated: "October 21, 2026",
  reviewsPolicyLastUpdated: "October 2026",
  howWeRankLastUpdated: "November 9, 2026",
} as const;

export const ANTI_SCAM_NOTICE =
  "Familiarise support will never ask for your OTP, UPI PIN, card CVV, or screen-sharing access." as const;

// Business Hours
export const BUSINESS_HOURS = {
  weekdays: "Monday - Friday: 9:00 AM - 6:00 PM IST",
  saturday: "Saturday: 10:00 AM - 4:00 PM IST",
  sunday: "Sunday: Closed",
} as const;

// Contact Form Categories
export const INQUIRY_CATEGORIES = [
  { value: "", label: "Select a category" },
  { value: "general", label: "General Inquiry" },
  { value: "technical", label: "Technical Support" },
  { value: "billing", label: "Billing & Payments" },
  { value: "booking", label: "Booking Issues" },
  { value: "consultant", label: "Consultant Support" },
  { value: "grievance", label: "Grievance Redressal" },
  { value: "enterprise", label: "Enterprise / Platform demo" },
  { value: "team-training", label: "Team training program" },
  { value: "feedback", label: "Feedback" },
  { value: "other", label: "Other" },
] as const;

// Support Resources Links
export const SUPPORT_LINKS = [
  { href: "/support", label: "Help Center" },
  { href: "/grievance", label: "Grievance Redressal" },
  { href: "/reviews-policy", label: "Reviews & Moderation Policy" },
  { href: "/how-we-rank", label: "How We Rank Experts & Programs" },
  { href: "/pricing", label: "Pricing & Platform Fees" },
  { href: "/refund", label: "Cancellation & Refund Policy" },
  { href: "/privacy", label: "Privacy Policy" },
  { href: "/terms", label: "Terms & Conditions" },
] as const;

// Page Meta Information
export const PAGE_META = {
  about: {
    title: "About Familiarise",
    description:
      "Familiarise is an online learning platform for live classes, webinars, tutoring and one-on-one sessions with experts personally interviewed by our founder.",
  },
  contact: {
    title: "Contact Us",
    description:
      "Questions about a class, a booking, a payment or a refund? Reach the team behind Familiarise.",
  },
  pricing: {
    title: "Pricing",
    description:
      "Experts set their prices in INR. You see the full amount you will pay before you pay.",
  },
  privacy: {
    title: "Privacy Policy",
    description:
      "Your privacy is important to us. This policy explains how we collect, use, and protect your personal information.",
  },
  terms: {
    title: "Terms & Conditions",
    description: "Please read these terms carefully before using our services",
  },
  refund: {
    title: "Cancellation & Refund Policy",
    description:
      "Understanding our cancellation and refund procedures for all service types",
  },
  support: {
    title: "Help Center",
    description:
      "Guides and answers for booking, payments, video sessions, payouts, and organisations",
  },
} as const;

// About Page Data
export const ABOUT_DATA = {
  mission:
    "To make quality education easier to reach by connecting learners with experts and educators, each personally interviewed by our founder, through live, interactive sessions. We aim to keep learning personal, affordable and effective.",
  vision:
    "A trusted place for live learning, where experts teach and learners grow through classes, webinars, tutoring and one-on-one sessions.",
  offerings: [
    {
      title: "Live Classes",
      description:
        "Group classes taught live by an instructor, with scheduled sessions and real-time interaction",
    },
    {
      title: "Webinars",
      description:
        "Live educational events and workshops on a single topic, with Q&A",
    },
    {
      title: "Tutoring & 1-on-1 Sessions",
      description:
        "Personal sessions with an expert on a subject or skill, tailored to your goals",
    },
    {
      title: "Subscriptions",
      description:
        "Recurring programs with regular live sessions over a set period",
    },
  ],
  howItWorks: [
    {
      step: 1,
      title: "Discover Experts",
      description:
        "Browse experts and educators by subject, and compare their classes, webinars and session plans",
    },
    {
      step: 2,
      title: "Book & Pay Securely",
      description:
        "Choose a class, webinar or session, pick a time, and pay in INR through Razorpay. The full amount is shown at checkout before you pay",
    },
    {
      step: 3,
      title: "Learn & Grow",
      description:
        "Join live over built-in video, with in-session chat and course materials in one place",
    },
  ],
  benefits: [
    {
      title: "Interviewed Experts",
      description:
        "Every expert is personally interviewed by our founder before taking bookings, their employer is confirmed, and reviews come only from people who attended a completed session",
    },
    {
      title: "Secure Payments",
      description:
        "Payments are processed by Razorpay; card details are not stored on our servers",
    },
    {
      title: "Flexible Scheduling",
      description:
        "Book sessions at your convenience with real-time availability",
    },
    {
      title: "Integrated Platform",
      description:
        "Video sessions, in-session chat and course materials in one place",
    },
    {
      title: "Transparent Pricing",
      description: "Prices in INR, with the full amount shown before you pay",
    },
    {
      title: "Responsive Support",
      description: `Every inquiry is acknowledged ${ACK_PROMISE_COPY}`,
    },
  ],
} as const;

// Pricing Page Data
export const PRICING_DATA = {
  commissionBenefits: [
    "Run secure payment processing",
    "Provide built-in video sessions, in-session chat and course materials",
    "Keep the platform secure and protect personal data",
    "Handle customer support, refunds and dispute resolution",
    "Keep improving the learning experience",
  ],
  paymentMethods: [
    "Credit Cards",
    "Debit Cards",
    "UPI",
    "Net Banking",
    "Wallets",
  ],
} as const;

const GST_LINE_REGISTERED =
  "GST at 18% is added at checkout for buyers in India, and the full total is shown before you pay.";
const GST_LINE_UNREGISTERED =
  "No GST is added at the moment: the price you see is the price you pay.";

/** The pricing page's "how it works" lines; the GST line follows the platform's registration. */
export function pricingHowItWorks(gstRegistered: boolean): string[] {
  return [
    "Experts set their own prices in Indian rupees (INR) for each class, webinar, session and plan.",
    "You see the exact list price on the expert's profile and on the booking page before you book.",
    gstRegistered ? GST_LINE_REGISTERED : GST_LINE_UNREGISTERED,
    "Familiarise's platform fee is taken from the expert's earnings; it is never added on top of what you pay.",
  ];
}

/** The pricing page's FAQ; the two GST answers follow the platform's registration. */
export function pricingFaqs(
  gstRegistered: boolean,
): { question: string; answer: string }[] {
  const bank =
    "Your bank or card issuer may apply its own charges, which we do not control.";
  return [
    {
      question: "How do I know the price before booking?",
      answer: gstRegistered
        ? "The list price of each class, webinar, session or plan is shown on the expert's profile and on the booking page, as the all-in price including GST. At checkout the total is shown again before you confirm."
        : "The price of each class, webinar, session or plan is shown on the expert's profile and on the booking page. It is the price you pay, and the total is shown again at checkout before you confirm.",
    },
    {
      question: "Are there any additional fees?",
      answer: gstRegistered
        ? `Familiarise adds no booking fee. The only addition to the expert's price is GST (18% for buyers in India), already included in the price shown. ${bank}`
        : `Familiarise adds no booking fee and no tax is added at the moment. ${bank}`,
    },
    {
      question: "Can I get a refund if I cancel?",
      answer:
        "Yes. Refund eligibility depends on when you cancel and on the type of service, and approved refunds go back to your original payment method.",
    },
    {
      question: "Why do prices vary between experts?",
      answer:
        "Experts set their own prices based on their expertise, experience, qualifications, and demand. This lets you choose an expert who fits your budget while experts are fairly paid for their knowledge and time.",
    },
    {
      question: "Do you offer discounts or promotional pricing?",
      answer:
        "We occasionally run platform-wide promotions, and a discount code can be entered at checkout. Subscribe to our newsletter to hear about them.",
    },
    {
      question: "How are experts paid?",
      answer:
        "Experts are paid after the session has been delivered and a short hold period has passed. The platform fee is deducted and the rest is transferred to the expert's registered bank account.",
    },
  ];
}

// Helper function to get mailto link
export const getMailtoLink = (email: string = COMPANY_INFO.email) =>
  `mailto:${email}`;

// Helper function to get tel link
export const getTelLink = (phone: string = COMPANY_INFO.phone) =>
  `tel:${phone}`;
