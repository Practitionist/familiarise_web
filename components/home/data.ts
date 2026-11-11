import {
  Award,
  BadgeCheck,
  BookOpen,
  Briefcase,
  Calendar,
  Clock,
  Code,
  FileCheck,
  Globe,
  GraduationCap,
  HeadphonesIcon,
  HeartHandshake,
  LayoutDashboard,
  Lightbulb,
  ListChecks,
  Lock,
  MessageSquare,
  Monitor,
  Palette,
  Shield,
  Star,
  TrendingUp,
  Users,
  Video,
  Zap,
} from "lucide-react";

export const FEATURES = [
  {
    icon: GraduationCap,
    title: "Live Classes",
    description:
      "Structured classes taught live by professionals across scheduled sessions, with course materials.",
    gradient: "from-zinc-700 to-zinc-900",
  },
  {
    icon: Users,
    title: "Live Webinars",
    description: "Interactive group sessions on a single topic, with Q&A.",
    gradient: "from-neutral-600 to-neutral-800",
  },
  {
    icon: Video,
    title: "Tutoring & 1-on-1 Sessions",
    description:
      "Personal video sessions with an expert, tailored to your subject and goals.",
    gradient: "from-stone-600 to-stone-800",
  },
  {
    icon: Calendar,
    title: "Subscriptions",
    description:
      "Ongoing programs with regular live sessions over a set period.",
    gradient: "from-gray-600 to-gray-800",
  },
];

// #1490 — the hardcoded "150+ experts" line under each category is gone. The
// card now renders a real per-domain consultant count, looked up by name from
// the landing loader, and renders no line at all where that count is zero.
export const CATEGORIES = [
  {
    icon: Code,
    name: "Technology",
    color: "bg-zinc-900",
  },
  {
    icon: Briefcase,
    name: "Business",
    color: "bg-zinc-800",
  },
  { icon: Palette, name: "Design", color: "bg-zinc-700" },
  {
    icon: TrendingUp,
    name: "Marketing",
    color: "bg-zinc-800",
  },
  {
    icon: HeartHandshake,
    name: "Career Coach",
    color: "bg-zinc-900",
  },
  {
    icon: GraduationCap,
    name: "Education",
    color: "bg-zinc-700",
  },
  {
    icon: Lightbulb,
    name: "Startups",
    color: "bg-zinc-800",
  },
  {
    icon: Globe,
    name: "Languages",
    color: "bg-zinc-900",
  },
];

export const BENEFITS = [
  {
    title: "Learn Live",
    description:
      "Join live classes, webinars and one-on-one sessions where you can ask questions and get answers in real time.",
    icon: Zap,
  },
  {
    title: "Interviewed Experts",
    description:
      "Every expert is personally interviewed by our founder before taking bookings, and reviews come only from people who attended a completed session.",
    icon: BadgeCheck,
  },
  {
    title: "Learn From Practitioners",
    description:
      "Study with working professionals across technology, business, design, and more.",
    icon: GraduationCap,
  },
  {
    title: "Flexible Learning",
    description:
      "Choose your schedule, pace, and learning format. From a single session to a full course.",
    icon: Calendar,
  },
];

export const HOW_IT_WORKS = [
  {
    step: 1,
    title: "Find Your Expert",
    description:
      "Browse our curated network of professionals across various domains.",
  },
  {
    step: 2,
    title: "Book a Session",
    description:
      "Choose a class, webinar or session type, then pick a time slot that fits your schedule.",
  },
  {
    step: 3,
    title: "Connect & Learn",
    description:
      "Join your session on our platform over built-in video, with chat and course materials alongside.",
  },
  {
    step: 4,
    title: "Grow Together",
    description:
      "Keep learning with session follow-ups, course materials and your next booking.",
  },
];

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
      "Payments are processed by Razorpay. Refunds and dispute handling are built in.",
  },
  {
    icon: LayoutDashboard,
    title: "Personal Dashboard",
    description:
      "Your command center for bookings, sessions, earnings, and analytics—all in one place.",
  },
  {
    icon: Video,
    title: "Session Recordings",
    description:
      "Record your sessions with one click. Review key moments and insights anytime.",
  },
  {
    icon: Star,
    title: "Reviews & Ratings",
    description:
      "Rate your sessions and read reviews from people who attended completed sessions to find the perfect expert.",
  },
  {
    icon: BadgeCheck,
    title: "Interviewed Experts",
    description:
      "Our founder personally interviews every expert, and their employer is confirmed by work email or LinkedIn.",
  },
  {
    icon: MessageSquare,
    title: "In-app Messaging",
    description:
      "Direct communication with experts. Open support cases and track issue resolution.",
  },
  {
    icon: HeadphonesIcon,
    title: "Support System",
    description:
      "Priority-based support cases with issue tracking for sessions, payments, and more.",
  },
  {
    icon: FileCheck,
    title: "Document Review",
    description:
      "Upload resumes, portfolios, or documents for expert review with detailed feedback.",
  },
  {
    icon: BookOpen,
    title: "Learning Materials",
    description:
      "Consultants upload resources, guides, and materials for each plan you purchase.",
  },
  {
    icon: ListChecks,
    title: "Live Seat Counts",
    description:
      "Every webinar and class shows exactly how many seats are left, and hosts can open more at any time.",
  },
];

export const TRUST_BADGES = [
  {
    icon: Shield,
    label: "Interviewed Experts",
    description:
      "Every expert is personally interviewed by our founder before taking bookings",
  },
  {
    icon: Lock,
    label: "Secure Payments",
    description: "Processed by Razorpay; we do not store card details",
  },
  {
    icon: Clock,
    label: "Clear Refund Policy",
    description:
      "Cancellation and refund terms are published and shown at booking",
  },
  {
    icon: Award,
    label: "Honest Reviews",
    description:
      "Reviews come only from people who attended a completed session",
  },
];

export const FAQ_ITEMS = [
  {
    question: "How do I find the right expert for my needs?",
    answer:
      "Our platform features detailed expert profiles with specializations, reviews, and ratings. You can filter by domain, experience level, availability, and price range.",
  },
  {
    question: "What types of sessions are available?",
    answer:
      "We offer four main formats: live classes for structured, in-depth learning, live webinars for group learning, tutoring and 1-on-1 video sessions for personalized guidance, and subscription plans for ongoing sessions with the same expert.",
  },
  {
    question: "How does the payment and refund process work?",
    // A missed consultation is refunded automatically; a missed class or
    // webinar gets a free make-up first.
    answer:
      "Payments are processed securely by Razorpay in INR, and GST is shown at checkout before you pay. The expert is paid only after your session has been delivered. Cancellation refunds follow the terms shown on your booking and our Cancellation & Refund Policy. If your expert isn't there for enough of a consultation, it's voided and refunded automatically — no request needed. Missed classes and webinars are offered a free make-up first, with an automatic refund if it goes unused.",
  },
  {
    question: "Can I become an expert on the platform?",
    answer:
      "Yes! We're always looking for qualified professionals. Apply through our 'Become an Expert' page. We verify credentials and experience to ensure quality for our users.",
  },
  {
    question: "What if I need to reschedule a session?",
    answer:
      "You can request one free reschedule if you do it more than 24 hours before your session. Both you and your expert receive notifications, and you can pick a new time that works for both parties.",
  },
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
