import {
  BadgeCheck,
  Briefcase,
  Calendar,
  Code,
  FileCheck,
  Globe,
  GraduationCap,
  HeartHandshake,
  Lightbulb,
  Lock,
  Monitor,
  Palette,
  Shield,
  TrendingUp,
  Users,
  Video,
} from "lucide-react";

export const FEATURES = [
  {
    icon: Video,
    title: "1-on-1 Sessions",
    description:
      "Personal video consultations with industry experts tailored to your specific needs and goals.",
    meta: "Single call",
  },
  {
    icon: Calendar,
    title: "Subscriptions",
    description:
      "Ongoing mentorship programs with regular check-ins and continuous support for your growth.",
    meta: "4–12 weeks",
  },
  {
    icon: GraduationCap,
    title: "Expert Classes",
    description:
      "Structured learning programs led by professionals with hands-on projects and certifications.",
    meta: "Multi-week cohort",
  },
  {
    icon: Users,
    title: "Live Webinars",
    description:
      "Interactive group sessions on trending topics with Q&A and networking opportunities.",
    meta: "Live · group",
  },
];

// #1490 — the hardcoded "150+ experts" line under each category is gone. The
// card now renders a real per-domain consultant count, looked up by name from
// the landing loader, and renders no line at all where that count is zero.
export const CATEGORIES = [
  { icon: Code, name: "Technology" },
  { icon: Briefcase, name: "Business" },
  { icon: Palette, name: "Design" },
  { icon: TrendingUp, name: "Marketing" },
  { icon: HeartHandshake, name: "Career Coach" },
  { icon: GraduationCap, name: "Education" },
  { icon: Lightbulb, name: "Startups" },
  { icon: Globe, name: "Languages" },
];

export const HOW_IT_WORKS = [
  {
    step: 1,
    title: "Find Your Expert",
    description:
      "Browse our curated network of verified professionals across various domains.",
  },
  {
    step: 2,
    title: "Book a Session",
    description:
      "Choose your preferred time slot and session type that fits your schedule.",
  },
  {
    step: 3,
    title: "Connect & Learn",
    description:
      "Join your session via our platform and start your transformation journey.",
  },
  {
    step: 4,
    title: "Grow Together",
    description:
      "Continue learning with follow-ups, resources, and our supportive community.",
  },
];

// Six headline capabilities, shown as a hairline grid under the offerings.
export const PLATFORM_FEATURES = [
  {
    icon: Monitor,
    title: "HD Video Calls",
    description:
      "Crystal clear video with screen sharing powered by Stream. Works on any device.",
  },
  {
    icon: Calendar,
    title: "Smart Scheduling",
    description:
      "Automatic timezone detection with weekly and custom availability slots.",
  },
  {
    icon: Lock,
    title: "Secure Payments",
    description:
      "Protected transactions with Stripe & Razorpay. Refunds and dispute handling built-in.",
  },
  {
    icon: BadgeCheck,
    title: "Verified Profiles",
    description:
      "Document-based verification for consultants. Staff review ensures quality experts.",
  },
  {
    icon: FileCheck,
    title: "Document Review",
    description:
      "Upload resumes, portfolios, or documents for expert review with detailed feedback.",
  },
  {
    icon: Video,
    title: "Session Recordings",
    description:
      "Record your sessions with one click. Review key moments and insights anytime.",
  },
];

export const FAQ_ITEMS = [
  {
    question: "How do I find the right expert for my needs?",
    answer:
      "Our platform features detailed expert profiles with specializations, reviews, and ratings. You can filter by domain, experience level, availability, and price range. We also offer a matching service for personalized recommendations.",
  },
  {
    question: "What types of sessions are available?",
    answer:
      "We offer four main formats: 1-on-1 video consultations for personalized guidance, subscription plans for ongoing mentorship, structured classes for in-depth learning, and live webinars for group learning and networking.",
  },
  {
    question: "How does the payment and refund process work?",
    // #1569 B3: "you can request a full refund" overstated an undefined
    // "guarantee period" and implied a manual request everywhere; a session
    // that doesn't happen because the host is absent is voided and
    // remedied automatically (D1, D4), and cancellation refunds follow the
    // terms shown on the booking. CodeRabbit caught the first draft for not
    // distinguishing the immediate-refund and make-up-first remedies, and
    // the #1833 review round caught "doesn't join" reading as a total
    // no-show rather than including a host absent long enough who joins late.
    answer:
      "We use secure payment processing. Payment is held in escrow until your session is completed. Cancellation refunds follow the terms shown on your booking. If your expert isn't there for enough of a consultation, it's voided and refunded automatically — no request needed. Missed classes and webinars are offered a free make-up first, with an automatic refund if it goes unused.",
  },
  {
    question: "Can I become an expert on the platform?",
    answer:
      "Yes! We're always looking for qualified professionals. Apply through our 'Become an Expert' page. We verify credentials and experience to ensure quality for our users.",
  },
  {
    question: "What if I need to reschedule a session?",
    answer:
      "You can reschedule up to 24 hours before your session at no extra cost. Both you and your expert receive notifications, and you can pick a new time that works for both parties.",
  },
];

export const COMPANY_LOGOS = [
  "Google",
  "Microsoft",
  "Amazon",
  "Meta",
  "Apple",
  "Netflix",
  "Stripe",
  "Airbnb",
];

export const ENTERPRISE_FEATURES = [
  {
    icon: Users,
    title: "Team training",
    description:
      "Book vetted experts for a whole team, with one plan covering every seat instead of individual expensing.",
  },
  {
    icon: Briefcase,
    title: "Sponsored sessions",
    description:
      "Your organisation pays; your people book. Set a budget or a per-seat allowance and let them choose their own experts.",
  },
  {
    icon: FileCheck,
    title: "Invoicing built for procurement",
    description:
      "Purchase orders, GST-compliant invoices, and Net-60 terms — not a corporate card and a pile of receipts.",
  },
  {
    icon: Shield,
    title: "Run your own expert network",
    description:
      "Agencies and institutions can host their experts on Familiarise and take a share of every booking.",
  },
];

export const EXPERT_PERKS = [
  "Set your own rates and availability",
  "Booking, video, and payouts handled for you",
  "Build a verified public profile and reviews",
];
