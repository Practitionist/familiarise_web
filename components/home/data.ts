import {
  Award,
  BadgeCheck,
  BookOpen,
  Briefcase,
  Calendar,
  Clock,
  FileCheck,
  GraduationCap,
  HeadphonesIcon,
  LayoutDashboard,
  ListChecks,
  Lock,
  MessageSquare,
  Monitor,
  Shield,
  Star,
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
    title: "Tutoring & Private Sessions",
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

export const BENEFITS = [
  {
    title: "Learn Live",
    description:
      "Join live classes, webinars and private sessions where you can ask questions and get answers in real time.",
    icon: Zap,
  },
  {
    title: "Vetted Experts",
    description:
      "Every expert is vetted before taking bookings, and reviews come only from people who booked a session that took place.",
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
      "Join your session on our own video platform, with chat and course materials alongside.",
  },
  {
    step: 4,
    title: "Grow Together",
    description:
      "Keep learning with session notes, course materials and your next booking.",
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
    title: "Verified Experts",
    description:
      "Every expert is vetted before listing, and their employer is confirmed by work email or LinkedIn.",
  },
  {
    icon: MessageSquare,
    title: "Messaging",
    description:
      "Direct communication with experts. Open support cases and track issue resolution.",
  },
  {
    icon: HeadphonesIcon,
    title: "Support System",
    description:
      "Support cases ranked by priority, with issue tracking for sessions, payments and more.",
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
    label: "Vetted Experts",
    description: "Every expert is vetted before taking bookings",
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
      "Reviews come only from people who booked a session that took place",
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
      "We offer four main formats: live classes for structured, deep learning, live webinars for group learning, tutoring and private video sessions for personalized guidance, and subscription plans for ongoing sessions with the same expert.",
  },
  {
    question: "How does the payment and refund process work?",
    // A missed consultation is refunded automatically; a missed class or
    // webinar gets a free make-up first.
    answer:
      "Payments are processed securely by Razorpay in INR, and GST is shown at checkout before you pay. The expert is paid only after your session has been delivered. Cancellation refunds follow the terms shown on your booking and our Cancellation & Refund Policy. If your expert isn't there for enough of a consultation, it's voided and refunded automatically — no request needed. Missed classes and webinars are offered a free replacement session first, with an automatic refund if it goes unused.",
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
      "Your organisation pays; your people book. Set a budget or an allowance for each seat and let them choose their own experts.",
  },
  {
    icon: FileCheck,
    title: "Invoicing built for procurement",
    description:
      "Purchase orders, GST invoices and 60 day payment terms, not a corporate card and a pile of receipts.",
  },
  {
    icon: Shield,
    title: "Run your own expert network",
    description:
      "Agencies and institutions can host their experts on Familiarise and take a share of every booking.",
  },
];
