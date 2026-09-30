"use client";

import { ArrowRight, Building2, Check, Sparkles } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/utils/tailwind";
import { ENTERPRISE_FEATURES, EXPERT_PERKS } from "./data";
import { Reveal, Section, surface } from "./primitives";

function PathCard({
  icon,
  eyebrow,
  title,
  description,
  points,
  primary,
  secondary,
  highlighted = false,
  delay = 0,
}: {
  icon: ReactNode;
  eyebrow: string;
  title: ReactNode;
  description: string;
  points: string[];
  primary: { href: string; label: string };
  secondary: { href: string; label: string };
  highlighted?: boolean;
  delay?: number;
}) {
  return (
    <Reveal
      delay={delay}
      className={cn(
        surface,
        "relative flex flex-col overflow-hidden p-8 md:p-10",
        highlighted &&
          "bg-[radial-gradient(ellipse_at_top_right,rgba(255,255,255,0.08),transparent_60%)]",
      )}
    >
      <div className="flex items-center gap-2 text-sm text-zinc-400">
        {icon}
        {eyebrow}
      </div>
      <h2 className="mt-6 font-serif text-3xl leading-tight tracking-tight text-white md:text-4xl">
        {title}
      </h2>
      <p className="mt-4 leading-relaxed text-zinc-400">{description}</p>

      <ul className="mt-8 space-y-3">
        {points.map((point) => (
          <li key={point} className="flex items-start gap-3 text-sm text-zinc-300">
            <Check className="mt-0.5 h-4 w-4 shrink-0 text-zinc-500" />
            {point}
          </li>
        ))}
      </ul>

      <div className="mt-auto flex flex-col gap-3 pt-10 sm:flex-row">
        <Button
          asChild
          className="group h-11 rounded-full bg-white px-5 font-medium text-zinc-950 hover:bg-zinc-200"
        >
          <Link href={primary.href}>
            {primary.label}
            <ArrowRight className="ml-1.5 h-4 w-4 transition-transform group-hover:translate-x-0.5" />
          </Link>
        </Button>
        <Button
          asChild
          variant="ghost"
          className="h-11 rounded-full px-5 text-zinc-300 hover:bg-white/[0.06] hover:text-white"
        >
          <Link href={secondary.href}>{secondary.label}</Link>
        </Button>
      </div>
    </Reveal>
  );
}

/**
 * The two "which side are you on?" paths — organisations and experts — side by
 * side at the end of the page. Replaces the separate Enterprise and Become an
 * Expert sections.
 */
export function AudiencePathsSection() {
  return (
    <Section id="get-started">
      <div className="grid gap-4 lg:grid-cols-2">
        <PathCard
          icon={<Building2 className="h-4 w-4" />}
          eyebrow="For teams & organisations"
          title={
            <>
              Bring Familiarise to your{" "}
              <em className="italic text-zinc-400">whole team</em>
            </>
          }
          description="Sponsor sessions for your people, run structured mentorship programmes, or host your own experts — with the billing your finance team expects."
          points={ENTERPRISE_FEATURES.map((f) => f.title)}
          primary={{ href: "/enterprise", label: "Explore Enterprise" }}
          secondary={{
            href: "/explore/enterprise/organisations",
            label: "Browse organisations",
          }}
        />
        <PathCard
          highlighted
          delay={0.08}
          icon={<Sparkles className="h-4 w-4" />}
          eyebrow="For experts"
          title={
            <>
              Share what you know.{" "}
              <em className="italic text-zinc-400">Get paid for it.</em>
            </>
          }
          description="Join a network of verified practitioners. Set your own rates and schedule, and let us handle booking, video and payments."
          points={EXPERT_PERKS}
          primary={{ href: "/become-an-expert", label: "Apply as an expert" }}
          secondary={{ href: "#faq", label: "Read the FAQ" }}
        />
      </div>
    </Section>
  );
}
