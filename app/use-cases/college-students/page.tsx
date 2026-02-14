import UseCasePageLayout from "../UseCasePageLayout";
import type { UseCasePageData } from "../UseCasePageLayout";

const data: UseCasePageData = {
  title: "Career Guidance Before You Graduate",
  subtitle:
    "Stop guessing what comes next. Connect with industry professionals who've been where you are — and get personalized advice to land your first role.",
  ctaLabel: "Find Your Mentor",
  ctaHref: "/explore/experts",
  painPoints: [
    {
      title: "Campus placements feel like a lottery",
      description:
        "You prepare for months but the process is opaque. Which companies to target, how to stand out, what skills actually matter — there's no one to ask who's been through it recently.",
    },
    {
      title: "Generic career advice doesn't apply to you",
      description:
        "YouTube videos and blog posts give broad tips. You need someone who understands your specific branch, college tier, and career goals to give advice that's actually actionable.",
    },
    {
      title: "No real-world project experience",
      description:
        "Your resume has coursework and academic projects, but recruiters want to see real impact. You don't know where to start or how to build something meaningful.",
    },
    {
      title: "Unclear on which career path to choose",
      description:
        "Software engineering, data science, product management, consulting — every option sounds good on paper. Without insider perspective, it's impossible to choose wisely.",
    },
  ],
  solutions: [
    {
      title: "1-on-1 consultations with industry professionals",
      description:
        "Book a session with engineers, PMs, and designers at top companies. Get resume reviews, mock interviews, and career roadmap advice tailored to your background.",
    },
    {
      title: "Mock interviews that mirror real processes",
      description:
        "Practice DSA rounds, system design, HR interviews, and case studies with consultants who've conducted these interviews at their companies.",
    },
    {
      title: "Portfolio and resume reviews from hiring managers",
      description:
        "Get your resume and GitHub profile reviewed by people who actually make hiring decisions. Learn what stands out and what gets filtered out.",
    },
    {
      title: "Domain exploration sessions",
      description:
        "Not sure if you want backend, frontend, ML, or DevOps? Book short exploration sessions with experts in each domain to understand day-to-day work and growth paths.",
    },
  ],
  categories: [
    { label: "Technology", href: "/explore/experts?category=technology" },
    { label: "Business", href: "/explore/experts?category=business" },
    { label: "Design", href: "/explore/experts?category=design" },
    { label: "Education", href: "/explore/experts?category=education" },
  ],
  bottomCtaTitle: "Your Career Starts With One Conversation",
  bottomCtaDescription:
    "Join thousands of students who've fast-tracked their careers with personalized mentorship. Your first session could change everything.",
};

export default function CollegeStudentsPage() {
  return <UseCasePageLayout data={data} />;
}
