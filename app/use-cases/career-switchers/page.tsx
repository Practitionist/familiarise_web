import UseCasePageLayout from "../UseCasePageLayout";
import type { UseCasePageData } from "../UseCasePageLayout";

const data: UseCasePageData = {
  title: "Navigate the Career Switch With Confidence",
  subtitle:
    "Switching from service to product, changing domains, or pivoting entirely? Talk to people who've made the same transition — and learn what actually works.",
  ctaLabel: "Talk to a Career Switcher",
  ctaHref: "/explore/experts",
  painPoints: [
    {
      title: "Your experience doesn't translate on paper",
      description:
        "You have 3–8 years of solid work, but recruiters don't see it as relevant. Your resume gets filtered before a human even reads it because the keywords don't match.",
    },
    {
      title: "Don't know where to start",
      description:
        "Should you learn DSA? Build projects? Get a certification? Do a bootcamp? The advice online is contradictory and overwhelming.",
    },
    {
      title: "Interview processes are completely different",
      description:
        "Service company interviews test different skills than product companies. You need to understand new formats — system design, behavioral rounds, take-home assignments.",
    },
    {
      title: "Fear of taking a step back",
      description:
        "Switching often means a pay cut or a lower title. You're unsure if the short-term sacrifice is worth the long-term gain, and there's no one to validate your plan.",
    },
  ],
  solutions: [
    {
      title: "Transition roadmaps from successful switchers",
      description:
        "Connect with professionals who've made the exact switch you're planning — service to product, IT to consulting, engineering to PM. Get a realistic timeline and action plan.",
    },
    {
      title: "Resume and LinkedIn makeovers",
      description:
        "Reframe your experience for your target industry. Consultants help you rewrite bullet points, highlight transferable skills, and position yourself as a strong candidate.",
    },
    {
      title: "Domain-specific interview prep",
      description:
        "Practice the exact interview format used by your target companies. From DSA to system design to case studies — prepare with someone who's been on the other side.",
    },
    {
      title: "Honest comp and career trajectory advice",
      description:
        "Understand realistic salary expectations, growth timelines, and what your first 6 months will look like. Make decisions based on data, not hope.",
    },
  ],
  categories: [
    { label: "Technology", href: "/explore/experts?domain=Technology" },
    { label: "Business", href: "/explore/experts?domain=Business" },
    { label: "Creative Arts", href: "/explore/experts?domain=Creative Arts" },
    { label: "Personal Development", href: "/explore/experts?domain=Personal Development" },
  ],
  bottomCtaTitle: "Your Next Chapter Starts Here",
  bottomCtaDescription:
    "Every successful career switcher had a moment where they decided to get real guidance. This is yours. Book a session and start building your transition plan today.",
};

export default function CareerSwitchersPage() {
  return <UseCasePageLayout data={data} />;
}
