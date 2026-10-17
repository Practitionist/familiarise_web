import Link from "next/link";
import {
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  Compass,
  GraduationCap,
  MessagesSquare,
  Radio,
  Users,
} from "lucide-react";
import { FamiliariseMark } from "@/components/brand/FamiliariseLogo";
import {
  LandingContainer,
  LandingTextLink,
  SectionIntro,
} from "./LandingShared";

const FORMATS = [
  {
    icon: MessagesSquare,
    label: "One-to-one consultations",
    description:
      "A focused conversation for a question, a decision, or a fresh perspective.",
    href: "/explore/experts",
    link: "Find your expert",
    number: "01",
  },
  {
    icon: Compass,
    label: "Ongoing mentorship",
    description:
      "Build momentum over time with guidance from someone who knows the path.",
    href: "/explore/experts",
    link: "Explore mentorship",
    number: "02",
  },
  {
    icon: GraduationCap,
    label: "Expert-led classes",
    description:
      "Go deeper into a subject with a structured curriculum and expert guidance.",
    href: "/explore/programs?tab=class",
    link: "Explore classes",
    number: "03",
  },
  {
    icon: Radio,
    label: "Live webinars",
    description:
      "Discover new ideas and learn alongside others in a live, expert-led session.",
    href: "/explore/programs?tab=webinar",
    link: "Explore webinars",
    number: "04",
  },
] as const;

export function LandingFormats() {
  return (
    <section className="bg-[#f7f7f3] py-16 sm:py-20 lg:py-24">
      <LandingContainer>
        <SectionIntro
          eyebrow="Make it your own"
          title="Different goals. Different ways to grow."
          description="A single conversation or a longer journey. Choose the kind of guidance that works for you."
        />
        <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {FORMATS.map(({ icon: Icon, ...format }) => (
            <Link
              key={format.number}
              href={format.href}
              className="group flex flex-col rounded-2xl border border-zinc-200/80 bg-white p-6 transition-colors hover:border-zinc-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4"
            >
              <div className="mb-8 flex items-center justify-between">
                <Icon
                  className="size-6 text-zinc-800"
                  strokeWidth={1.5}
                  aria-hidden="true"
                />
                <span className="text-xs tabular-nums text-zinc-400">
                  {format.number}
                </span>
              </div>
              <h3 className="text-lg font-semibold leading-snug tracking-tight text-zinc-950">
                {format.label}
              </h3>
              <p className="mb-8 mt-3 flex-1 text-sm leading-relaxed text-zinc-600">
                {format.description}
              </p>
              <span className="flex items-center justify-between gap-2 text-xs font-medium text-zinc-900">
                {format.link}
                <ArrowUpRight className="size-4 shrink-0" aria-hidden="true" />
              </span>
            </Link>
          ))}
        </div>
      </LandingContainer>
    </section>
  );
}

const STEPS = [
  {
    title: "Find your person",
    description:
      "Explore expertise, experience, and reviews. Get a feel for who you want to learn from.",
  },
  {
    title: "Choose your next step",
    description:
      "Compare offerings and read the full details, curriculum, and booking terms.",
  },
  {
    title: "Book, connect, move forward",
    description:
      "Choose a time for a consultation or join a program. Your dashboard keeps the next steps together.",
  },
] as const;

export function LandingHowItWorks() {
  return (
    <section
      id="how-it-works"
      className="scroll-mt-24 bg-white py-16 sm:py-20 lg:py-24"
    >
      <LandingContainer className="grid items-center gap-12 lg:grid-cols-2 lg:gap-20">
        <div>
          <SectionIntro
            eyebrow="From a question to a next step"
            title="Good guidance starts with a conversation."
          />
          <ol className="mt-9 space-y-7">
            {STEPS.map((step, index) => (
              <li key={step.title} className="flex gap-4">
                <span
                  className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full border border-zinc-200 text-xs text-zinc-500"
                  aria-hidden="true"
                >
                  {index + 1}
                </span>
                <div>
                  <h3 className="text-base font-semibold text-zinc-950">
                    {step.title}
                  </h3>
                  <p className="mt-2 text-sm leading-relaxed text-zinc-600">
                    {step.description}
                  </p>
                </div>
              </li>
            ))}
          </ol>
          <LandingTextLink href="/explore/experts" className="mt-7">
            Take a look around
          </LandingTextLink>
        </div>
        <div
          aria-hidden="true"
          className="relative flex min-h-[380px] flex-col justify-center rounded-3xl bg-[#f1f1eb] p-6 sm:p-10"
        >
          <div className="mx-auto w-full max-w-sm rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
            <div className="mb-7 flex items-center justify-between">
              <FamiliariseMark className="size-8 text-zinc-900" />
              <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-zinc-500">
                Your next chapter
              </span>
            </div>
            <p className="text-xs text-zinc-500">A question worth exploring</p>
            <p className="mt-3 text-2xl font-medium leading-snug tracking-tight text-zinc-900">
              What could your
              <br />
              next step look like?
            </p>
            <div className="mt-7 flex items-center gap-3 rounded-xl bg-[#f7f7f3] p-4">
              <BookOpen className="size-5 text-zinc-600" strokeWidth={1.5} />
              <div>
                <p className="text-xs font-medium text-zinc-900">
                  Room for a new perspective
                </p>
                <p className="mt-1 text-[11px] text-zinc-500">
                  Your goals. Expert guidance.
                </p>
              </div>
            </div>
          </div>
          <p className="mt-6 text-center text-xs text-zinc-500">
            A little clarity can go a long way.
          </p>
        </div>
      </LandingContainer>
    </section>
  );
}

export function LandingAudiencePaths() {
  return (
    <section
      aria-label="For experts and teams"
      className="border-y border-zinc-200 bg-[#f7f7f3] py-12 sm:py-16"
    >
      <LandingContainer className="grid gap-8 md:grid-cols-2 md:gap-16">
        <div>
          <Compass
            className="mb-4 size-6 text-zinc-600"
            strokeWidth={1.5}
            aria-hidden="true"
          />
          <h2 className="text-xl font-semibold tracking-tight text-zinc-950">
            Your experience could be someone&apos;s next step.
          </h2>
          <p className="mt-3 max-w-md text-sm leading-relaxed text-zinc-600">
            Share what you know. Apply to join Familiarise as an expert.
          </p>
          <LandingTextLink href="/become-an-expert" className="mt-4">
            Become an expert
          </LandingTextLink>
        </div>
        <div className="border-t border-zinc-200 pt-8 md:border-l md:border-t-0 md:pl-16 md:pt-0">
          <Users
            className="mb-4 size-6 text-zinc-600"
            strokeWidth={1.5}
            aria-hidden="true"
          />
          <h2 className="text-xl font-semibold tracking-tight text-zinc-950">
            Help your whole team move forward.
          </h2>
          <p className="mt-3 max-w-md text-sm leading-relaxed text-zinc-600">
            Explore expert-led learning and mentorship for your organisation.
          </p>
          <LandingTextLink href="/enterprise" className="mt-4">
            Explore for teams
          </LandingTextLink>
        </div>
      </LandingContainer>
    </section>
  );
}

export function LandingFinalCTA() {
  return (
    <section className="bg-white pb-16 pt-8 sm:pb-20">
      <LandingContainer>
        <div className="flex flex-col justify-between gap-8 rounded-3xl bg-zinc-950 px-7 py-10 text-white sm:p-12 lg:flex-row lg:items-center">
          <div>
            <p className="mb-4 text-xs font-medium uppercase tracking-[0.14em] text-zinc-400">
              Start where you are
            </p>
            <h2 className="text-3xl font-semibold tracking-[-0.045em] sm:text-4xl">
              Your next step starts here.
            </h2>
            <p className="mt-4 max-w-md text-sm leading-relaxed text-zinc-300">
              Find the right guidance for what comes next.
            </p>
          </div>
          <Link
            href="/explore/experts"
            className="inline-flex min-h-12 shrink-0 items-center justify-center gap-4 rounded-xl bg-white px-6 py-4 text-sm font-semibold text-zinc-950 transition-colors hover:bg-zinc-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-white"
          >
            Find an expert <ArrowRight className="size-4" aria-hidden="true" />
          </Link>
        </div>
      </LandingContainer>
    </section>
  );
}
