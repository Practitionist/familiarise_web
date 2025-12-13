import {
  Award,
  BookOpen,
  Briefcase,
  Calendar,
  Clock,
  Code,
  Globe,
  GraduationCap,
  HeartHandshake,
  Lightbulb,
  Lock,
  MessageSquare,
  Monitor,
  Palette,
  Shield,
  TrendingUp,
  Users,
  Video,
  Zap,
} from "lucide-react";

export const FEATURES = [
  {
    icon: Video,
    title: "1-on-1 Sessions",
    description: "Personal video consultations with industry experts tailored to your specific needs and goals.",
    gradient: "from-zinc-700 to-zinc-900",
  },
  {
    icon: Calendar,
    title: "Subscriptions",
    description: "Ongoing mentorship programs with regular check-ins and continuous support for your growth.",
    gradient: "from-neutral-600 to-neutral-800",
  },
  {
    icon: GraduationCap,
    title: "Expert Classes",
    description: "Structured learning programs led by professionals with hands-on projects and certifications.",
    gradient: "from-stone-600 to-stone-800",
  },
  {
    icon: Users,
    title: "Live Webinars",
    description: "Interactive group sessions on trending topics with Q&A and networking opportunities.",
    gradient: "from-gray-600 to-gray-800",
  },
];

export const STATS = [
  { value: 10000, suffix: "+", label: "Active Users" },
  { value: 500, suffix: "+", label: "Expert Mentors" },
  { value: 50000, suffix: "+", label: "Sessions Completed" },
  { value: 4.9, suffix: "", label: "Average Rating" },
];

export const CATEGORIES = [
  { icon: Code, name: "Technology", count: "150+ experts", color: "bg-zinc-900" },
  { icon: Briefcase, name: "Business", count: "120+ experts", color: "bg-zinc-800" },
  { icon: Palette, name: "Design", count: "80+ experts", color: "bg-zinc-700" },
  { icon: TrendingUp, name: "Marketing", count: "90+ experts", color: "bg-zinc-800" },
  { icon: HeartHandshake, name: "Career Coach", count: "60+ experts", color: "bg-zinc-900" },
  { icon: GraduationCap, name: "Education", count: "70+ experts", color: "bg-zinc-700" },
  { icon: Lightbulb, name: "Startups", count: "50+ experts", color: "bg-zinc-800" },
  { icon: Globe, name: "Languages", count: "40+ experts", color: "bg-zinc-900" },
];

export const BENEFITS = [
  {
    title: "Accelerate Your Growth",
    description: "Gain years of industry insights in hours through personalized 1-on-1 sessions with vetted experts.",
    icon: Zap,
  },
  {
    title: "Build Your Network",
    description: "Connect with industry leaders and like-minded professionals in our exclusive community events.",
    icon: Users,
  },
  {
    title: "Learn From The Best",
    description: "Access cutting-edge knowledge from top professionals across tech, business, design, and more.",
    icon: GraduationCap,
  },
  {
    title: "Flexible Learning",
    description: "Choose your schedule, pace, and learning format. From quick consultations to comprehensive courses.",
    icon: Calendar,
  },
];

export const HOW_IT_WORKS = [
  {
    step: 1,
    title: "Find Your Expert",
    description: "Browse our curated network of verified professionals across various domains.",
  },
  {
    step: 2,
    title: "Book a Session",
    description: "Choose your preferred time slot and session type that fits your schedule.",
  },
  {
    step: 3,
    title: "Connect & Learn",
    description: "Join your session via our platform and start your transformation journey.",
  },
  {
    step: 4,
    title: "Grow Together",
    description: "Continue learning with follow-ups, resources, and our supportive community.",
  },
];

export const SUCCESS_STORIES = [
  {
    name: "Sarah Chen",
    role: "Software Engineer → Tech Lead",
    company: "Google",
    image: "/placeholder-user.jpg",
    story: "After 3 months of mentorship, I successfully transitioned from an individual contributor to leading a team of 8 engineers.",
    metric: "50% salary increase",
  },
  {
    name: "Marcus Johnson",
    role: "Student → Product Manager",
    company: "Stripe",
    image: "/placeholder-user.jpg",
    story: "My mentor helped me break into product management with zero experience. The mock interviews were game-changing.",
    metric: "Landed dream job",
  },
  {
    name: "Elena Rodriguez",
    role: "Designer → Design Director",
    company: "Airbnb",
    image: "/placeholder-user.jpg",
    story: "The strategic guidance I received helped me build a portfolio that stood out and accelerated my career.",
    metric: "3 promotions in 2 years",
  },
];

export const PLATFORM_FEATURES = [
  {
    icon: Monitor,
    title: "HD Video Calls",
    description: "Crystal clear video quality with screen sharing and recording options.",
  },
  {
    icon: Calendar,
    title: "Smart Scheduling",
    description: "Automatic timezone detection and calendar sync for hassle-free booking.",
  },
  {
    icon: Lock,
    title: "Secure Payments",
    description: "Protected transactions with escrow and money-back guarantee.",
  },
  {
    icon: MessageSquare,
    title: "In-app Messaging",
    description: "Direct communication with experts before and after sessions.",
  },
  {
    icon: BookOpen,
    title: "Session Notes",
    description: "AI-powered summaries and action items from your sessions.",
  },
  {
    icon: Award,
    title: "Certificates",
    description: "Earn verified certificates upon completing courses and programs.",
  },
];

export const TRUST_BADGES = [
  { icon: Shield, label: "Verified Experts", description: "All mentors are background-checked" },
  { icon: Lock, label: "Secure Platform", description: "Bank-level encryption for all data" },
  { icon: Clock, label: "Money-back Guarantee", description: "Full refund if not satisfied" },
  { icon: Award, label: "Quality Assured", description: "4.9★ average session rating" },
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
    answer: "Our platform features detailed expert profiles with specializations, reviews, and ratings. You can filter by domain, experience level, availability, and price range. We also offer a matching service for personalized recommendations.",
  },
  {
    question: "What types of sessions are available?",
    answer: "We offer four main formats: 1-on-1 video consultations for personalized guidance, subscription plans for ongoing mentorship, structured classes for in-depth learning, and live webinars for group learning and networking.",
  },
  {
    question: "How does the payment and refund process work?",
    answer: "We use secure payment processing. Payment is held in escrow until your session is completed. If you're not satisfied or your session doesn't happen, you can request a full refund within our guarantee period.",
  },
  {
    question: "Can I become an expert on the platform?",
    answer: "Yes! We're always looking for qualified professionals. Apply through our 'Become an Expert' page. We verify credentials and experience to ensure quality for our users.",
  },
  {
    question: "What if I need to reschedule a session?",
    answer: "You can reschedule up to 24 hours before your session at no extra cost. Both you and your expert receive notifications, and you can pick a new time that works for both parties.",
  },
];

export const COMPANY_LOGOS = [
  "Google", "Microsoft", "Amazon", "Meta", "Apple", "Netflix", "Stripe", "Airbnb"
];

