import UseCasePageLayout from "../UseCasePageLayout";
import type { UseCasePageData } from "../UseCasePageLayout";

const data: UseCasePageData = {
  title: "Long-Term Mentorship That Actually Works",
  subtitle:
    "One-off calls are great for quick answers. But real career transformation happens through ongoing relationships with mentors who know your story.",
  ctaLabel: "Find a Mentor",
  ctaHref: "/explore/experts",
  painPoints: [
    {
      title: "One-off advice doesn't stick",
      description:
        "You've had great conversations before, but without follow-through, the advice fades. You need someone who tracks your progress and holds you accountable.",
    },
    {
      title: "Hard to find committed mentors",
      description:
        "Everyone says 'find a mentor' but no one says how. Cold DMs on LinkedIn rarely work, and workplace mentors don't always have the right expertise.",
    },
    {
      title: "Your challenges evolve over time",
      description:
        "What you need help with in month 1 is different from month 6. A mentor who only knows your surface-level story can't give you the depth of guidance you need.",
    },
    {
      title: "No structure or accountability",
      description:
        "Even when you find a good mentor, the relationship often fizzles out. Without scheduled sessions and clear goals, both sides lose momentum.",
    },
  ],
  solutions: [
    {
      title: "Subscription-based mentorship plans",
      description:
        "Subscribe to ongoing sessions with your chosen mentor. Get regular check-ins — weekly or biweekly — with someone who understands your full context and career arc.",
    },
    {
      title: "Integrated video calls and chat",
      description:
        "No more juggling Zoom links and WhatsApp messages. Everything happens on one platform — scheduled calls, async questions, shared documents and notes.",
    },
    {
      title: "Goal tracking and session continuity",
      description:
        "Each session builds on the last. Your mentor knows your history, tracks your goals, and adjusts guidance as your situation changes.",
    },
    {
      title: "Access to classes and webinars",
      description:
        "Beyond 1-on-1s, join group webinars and classes hosted by your mentor or other experts. Get broader perspectives while maintaining your core mentoring relationship.",
    },
  ],
  categories: [
    { label: "Technology", href: "/explore/experts?category=technology" },
    { label: "Business", href: "/explore/experts?category=business" },
    { label: "Design", href: "/explore/experts?category=design" },
    { label: "Marketing", href: "/explore/experts?category=marketing" },
    { label: "Education", href: "/explore/experts?category=education" },
  ],
  bottomCtaTitle: "Invest in a Relationship, Not Just a Call",
  bottomCtaDescription:
    "The best mentors become career-long allies. Start a mentorship subscription today and build the kind of guidance that compounds over time.",
};

export default function MentorshipPage() {
  return <UseCasePageLayout data={data} />;
}
