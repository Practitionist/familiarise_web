import UseCasePageLayout from "../UseCasePageLayout";
import type { UseCasePageData } from "../UseCasePageLayout";

const data: UseCasePageData = {
  title: "Accelerate Your First 1–5 Years",
  subtitle:
    "The early years define your trajectory. Get strategic guidance from professionals who've navigated the same growth phase — and came out ahead.",
  ctaLabel: "Find an Expert",
  ctaHref: "/explore/experts",
  painPoints: [
    {
      title: "No senior mentor at work",
      description:
        "Your manager is busy, senior engineers are swamped, and there's no formal mentorship program. You're left figuring things out alone through trial and error.",
    },
    {
      title: "Stuck in a role that doesn't grow",
      description:
        "You joined for the brand name but the work is repetitive. You're not learning new skills, your title isn't progressing, and you're worried about stagnating.",
    },
    {
      title: "Don't know how to negotiate or switch",
      description:
        "Should you ask for a raise, switch teams, or change companies? You don't have enough data points to make a confident decision about your next move.",
    },
    {
      title: "Imposter syndrome is real",
      description:
        "Everyone around you seems to know what they're doing. You're constantly second-guessing your skills and wondering if you're falling behind your peers.",
    },
  ],
  solutions: [
    {
      title: "Career strategy sessions with senior professionals",
      description:
        "Book 1-on-1 calls with people 5–10 years ahead of you. Get honest advice on promotions, skill gaps, team dynamics, and when to make your next move.",
    },
    {
      title: "Skill-gap analysis and learning roadmaps",
      description:
        "Consultants help you identify exactly what skills you need for your target role — and create a focused plan to build them within 3–6 months.",
    },
    {
      title: "Salary negotiation and offer evaluation",
      description:
        "Before you accept that next offer, get it reviewed by someone who understands comp structures, equity, and market rates for your level and location.",
    },
    {
      title: "Ongoing mentorship through subscriptions",
      description:
        "Don't limit yourself to one-off calls. Subscribe to a mentor for regular check-ins, accountability, and continuous guidance as your career evolves.",
    },
  ],
  categories: [
    { label: "Technology", href: "/explore/experts?category=technology" },
    { label: "Business", href: "/explore/experts?category=business" },
    { label: "Marketing", href: "/explore/experts?category=marketing" },
    { label: "Design", href: "/explore/experts?category=design" },
  ],
  bottomCtaTitle: "Don't Navigate Your Career Alone",
  bottomCtaDescription:
    "The professionals who grow fastest are the ones who ask for help early. One conversation with the right mentor can save you years of guesswork.",
};

export default function EarlyCareerPage() {
  return <UseCasePageLayout data={data} />;
}
