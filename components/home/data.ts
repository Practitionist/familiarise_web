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
    icon: Video,
    title: "1-on-1 Consultations",
    badge: "Personalised Advice",
    meta: "30 – 60 min live video",
    description:
      "Focused, private sessions tailored to your exact question — architecture reviews, mock interviews, portfolio critiques, or career strategy.",
    href: "/explore/experts",
    cta: "Find a 1:1 expert",
    gradient: "from-zinc-700 to-zinc-900",
  },
  {
    icon: Calendar,
    title: "Mentorship Subscriptions",
    badge: "Ongoing Growth",
    meta: "Recurring calls + async chat",
    description:
      "Long-term mentorship with recurring check-ins, shared action plans, and continuous support between sessions as you navigate a transition.",
    href: "/explore/experts",
    cta: "Explore mentors",
    gradient: "from-neutral-600 to-neutral-800",
  },
  {
    icon: GraduationCap,
    title: "Cohort Classes",
    badge: "Multi-Week Curriculum",
    meta: "Small-group structured learning",
    description:
      "Multi-session cohorts led by working practitioners with live instruction, hands-on assignments, and direct feedback alongside peers.",
    href: "/explore/programs?type=class",
    cta: "Browse classes",
    gradient: "from-stone-600 to-stone-800",
  },
  {
    icon: Users,
    title: "Live Webinars",
    badge: "Interactive Workshops",
    meta: "60 – 90 min live + Q&A",
    description:
      "Focused single-session deep dives on emerging tools, hiring playbooks, and industry trends with live Q&A and open seat counts.",
    href: "/explore/programs?type=webinar",
    cta: "See upcoming webinars",
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
    description: "Software engineering, AI/ML, cloud & system design",
    color: "bg-zinc-900",
  },
  {
    icon: Briefcase,
    name: "Business",
    description: "Product management, strategy, operations & finance",
    color: "bg-zinc-800",
  },
  {
    icon: Palette,
    name: "Design",
    description: "Product design, UX research, design systems & brand",
    color: "bg-zinc-700",
  },
  {
    icon: TrendingUp,
    name: "Marketing",
    description: "Growth marketing, SEO, positioning & go-to-market",
    color: "bg-zinc-800",
  },
  {
    icon: HeartHandshake,
    name: "Career Coach",
    description: "Interview prep, resume reviews & leadership coaching",
    color: "bg-zinc-900",
  },
  {
    icon: GraduationCap,
    name: "Education",
    description: "Academic advising, research guidance & test prep",
    color: "bg-zinc-700",
  },
  {
    icon: Lightbulb,
    name: "Startups",
    description: "Fundraising, pitch decks, zero-to-one & founder advisory",
    color: "bg-zinc-800",
  },
  {
    icon: Globe,
    name: "Languages",
    description: "Business communication & cross-cultural fluency",
    color: "bg-zinc-900",
  },
];

export const BENEFITS = [
  {
    title: "Accelerate Your Growth",
    description:
      "Gain years of industry insights in hours through personalized 1-on-1 sessions with vetted experts.",
    icon: Zap,
  },
  {
    title: "Build Your Network",
    description:
      "Connect with industry leaders and like-minded professionals in our exclusive community events.",
    icon: Users,
  },
  {
    title: "Learn From The Best",
    description:
      "Access cutting-edge knowledge from top professionals across tech, business, design, and more.",
    icon: GraduationCap,
  },
  {
    title: "Flexible Learning",
    description:
      "Choose your schedule, pace, and learning format. From quick consultations to comprehensive courses.",
    icon: Calendar,
  },
];

export const HOW_IT_WORKS = [
  {
    step: 1,
    number: "01",
    title: "Discover & Filter Verified Experts",
    description:
      "Search by domain, company background, price range, and real participant reviews. Every listed consultant passes credential and profile verification before going live.",
  },
  {
    step: 2,
    number: "02",
    title: "Book a Time Slot with Escrow Protection",
    description:
      "Pick a 1:1 consultation, mentorship subscription, cohort class, or live webinar in your local timezone. Your payment is held safely until the session completes.",
  },
  {
    step: 3,
    number: "03",
    title: "Meet Live in HD, Record & Follow Up",
    description:
      "Join directly in your browser with HD video, screen sharing, in-app chat, shared learning materials, and one-click session recordings.",
  },
];

export const SUCCESS_STORIES = [
  {
    name: "Sarah Chen",
    role: "Software Engineer → Tech Lead",
    company: "Google",
    image: "/placeholder-user.jpg",
    story:
      "After 3 months of mentorship, I successfully transitioned from an individual contributor to leading a team of 8 engineers.",
    metric: "50% salary increase",
  },
  {
    name: "Marcus Johnson",
    role: "Student → Product Manager",
    company: "Stripe",
    image: "/placeholder-user.jpg",
    story:
      "My mentor helped me break into product management with zero experience. The mock interviews were game-changing.",
    metric: "Landed dream job",
  },
  {
    name: "Elena Rodriguez",
    role: "Designer → Design Director",
    company: "Airbnb",
    image: "/placeholder-user.jpg",
    story:
      "The strategic guidance I received helped me build a portfolio that stood out and accelerated my career.",
    metric: "3 promotions in 2 years",
  },
];

export const PLATFORM_FEATURES = [
  {
    icon: Monitor,
    title: "HD Video Calls",
    description:
      "Browser-native HD video and screen sharing powered by Stream — no downloads required.",
  },
  {
    icon: Calendar,
    title: "Smart Scheduling",
    description:
      "Automatic timezone detection with live weekly and custom availability slots.",
  },
  {
    icon: Lock,
    title: "Escrow-Protected Payments",
    description:
      "Checkout in local or global currencies via Stripe & Razorpay with automatic no-show protection.",
  },
  {
    icon: Video,
    title: "Session Recordings",
    description:
      "Record sessions with one click and revisit key explanations and action items anytime.",
  },
  {
    icon: BadgeCheck,
    title: "Verified Profiles",
    description:
      "Every consultant undergoes staff credential and profile review before appearing in search.",
  },
  {
    icon: MessageSquare,
    title: "In-App Messaging & Materials",
    description:
      "Share resumes, design files, code repos, and follow-up notes in one workspace.",
  },
  {
    icon: LayoutDashboard,
    title: "Personal Dashboard",
    description:
      "Your command center for bookings, sessions, earnings, and analytics—all in one place.",
  },
  {
    icon: Star,
    title: "Reviews & Ratings",
    description:
      "Rate your sessions and read verified reviews to find the perfect expert.",
  },
  {
    icon: HeadphonesIcon,
    title: "Support System",
    description:
      "Priority-based ticket system with issue tracking for sessions, payments, and more.",
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
    label: "Verified Experts",
    description: "Every profile is staff-reviewed before listing",
  },
  {
    icon: Lock,
    label: "Escrow Protection",
    description: "Funds are held securely until session completion",
  },
  {
    icon: Clock,
    label: "Automatic No-Show Remedy",
    description: "Instant refund or free make-up if a host is absent",
  },
  {
    icon: Award,
    label: "Verified Reviews Only",
    // #1485 — was "4.9★ average session rating", a number with nothing behind
    // it. What replaces it is a property of the review system itself, so it
    // stays true at every scale.
    description: "Ratings come only from verified session participants",
  },
];

export const UPCOMING_EVENTS = [
  {
    title: "Breaking into Tech Leadership",
    host: "David Park",
    date: "Dec 20, 2025",
    time: "6:00 PM EST",
    attendees: 156,
    type: "Webinar",
  },
  {
    title: "Portfolio Review Workshop",
    host: "Lisa Wang",
    date: "Dec 22, 2025",
    time: "2:00 PM EST",
    attendees: 89,
    type: "Workshop",
  },
  {
    title: "Startup Fundraising 101",
    host: "Alex Rivera",
    date: "Dec 28, 2025",
    time: "11:00 AM EST",
    attendees: 234,
    type: "Class",
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
