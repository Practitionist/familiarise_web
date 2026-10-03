"use client";

import { motion } from "framer-motion";
import {
  ArrowRight,
  BadgeCheck,
  CalendarDays,
  CheckCircle2,
  Star,
  Video,
} from "lucide-react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import type { ExpertStatKey, IPublicStat } from "@/lib/data/public-stats";
import { reveal, revealTransition } from "@/lib/motion";
import { cn } from "@/utils/tailwind";
import { container, surface } from "./primitives";

/* -------------------------------------------------------------------------- */
/* Product visual                                                             */
/* -------------------------------------------------------------------------- */

// Illustrative only — this is a picture of the product, not a listing. It is
// deliberately not a real consultant so the hero never advertises someone who
// may have left the platform.
const PREVIEW_EXPERT = {
  initials: "AR",
  name: "Ananya Rao",
  headline: "Principal Product Manager",
  years: 12,
  tags: ["Product strategy", "PM interviews", "0 → 1"],
};

const PREVIEW_SLOTS = ["9:30", "11:00", "14:30", "16:00", "18:30", "20:00"];
const PREVIEW_DAYS = [
  { d: "Mon", n: 14 },
  { d: "Tue", n: 15 },
  { d: "Wed", n: 16 },
  { d: "Thu", n: 17 },
  { d: "Fri", n: 18 },
];

function ProductPreview() {
  return (
    <div className="relative mx-auto w-full max-w-md lg:max-w-none">
      {/* Soft light behind the stack */}
      <div
        aria-hidden
        className="absolute -inset-10 rounded-[3rem] bg-[radial-gradient(closest-side,rgba(255,255,255,0.08),transparent)]"
      />

      {/* Expert card */}
      <div className={cn(surface, "relative bg-zinc-950/80 p-6 backdrop-blur-xl")}>
        <div className="flex items-start gap-4">
          <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-zinc-200 to-zinc-500 text-base font-semibold text-zinc-950">
            {PREVIEW_EXPERT.initials}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <p className="truncate font-medium text-white">
                {PREVIEW_EXPERT.name}
              </p>
              <BadgeCheck className="h-4 w-4 shrink-0 text-zinc-300" />
            </div>
            <p className="truncate text-sm text-zinc-400">
              {PREVIEW_EXPERT.headline}
            </p>
            <div className="mt-2 flex items-center gap-3 text-xs text-zinc-400">
              <span className="inline-flex items-center gap-1 text-zinc-200">
                <Star className="h-3.5 w-3.5 fill-current" />
                4.9
              </span>
              <span aria-hidden className="h-3 w-px bg-white/10" />
              <span>{PREVIEW_EXPERT.years} yrs experience</span>
            </div>
          </div>
        </div>
        <div className="mt-5 flex flex-wrap gap-2">
          {PREVIEW_EXPERT.tags.map((tag) => (
            <span
              key={tag}
              className="rounded-full border border-white/[0.08] bg-white/[0.03] px-2.5 py-1 text-xs text-zinc-300"
            >
              {tag}
            </span>
          ))}
        </div>
      </div>

      {/* Booking card, overlapping the expert card */}
      <div
        className={cn(
          surface,
          "relative -mt-3 ml-6 bg-zinc-900/90 p-6 backdrop-blur-xl sm:ml-12",
        )}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm text-white">
            <CalendarDays className="h-4 w-4 text-zinc-400" />
            Book a 1-on-1
          </div>
          <span className="text-xs text-zinc-400">45 min · Video</span>
        </div>

        <div className="mt-5 grid grid-cols-5 gap-2">
          {PREVIEW_DAYS.map((day, i) => (
            <div
              key={day.d}
              className={cn(
                "rounded-xl border py-2 text-center",
                i === 3
                  ? "border-white bg-white text-zinc-950"
                  : "border-white/[0.08] text-zinc-400",
              )}
            >
              <div className="text-[10px] uppercase tracking-wider opacity-70">
                {day.d}
              </div>
              <div className="text-sm font-medium">{day.n}</div>
            </div>
          ))}
        </div>

        <div className="mt-3 grid grid-cols-3 gap-2">
          {PREVIEW_SLOTS.map((slot, i) => (
            <div
              key={slot}
              className={cn(
                "rounded-lg border py-2 text-center text-xs tabular-nums",
                i === 2
                  ? "border-white/40 bg-white/10 text-white"
                  : "border-white/[0.06] text-zinc-400",
              )}
            >
              {slot}
            </div>
          ))}
        </div>

        <div className="mt-5 flex h-10 items-center justify-center rounded-full bg-white text-sm font-medium text-zinc-950">
          Confirm Thu 17 · 14:30
        </div>
      </div>

      {/* Confirmation toast */}
      <div
        className={cn(
          surface,
          "absolute -left-2 bottom-10 hidden items-center gap-3 bg-zinc-900/95 px-4 py-3 backdrop-blur-xl sm:flex lg:-left-10",
        )}
      >
        <CheckCircle2 className="h-5 w-5 text-white" />
        <div>
          <p className="text-sm font-medium text-white">Session confirmed</p>
          <p className="flex items-center gap-1 text-xs text-zinc-400">
            <Video className="h-3 w-3" /> Link sent to your calendar
          </p>
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Hero                                                                       */
/* -------------------------------------------------------------------------- */

export function HeroSection({
  stats,
}: {
  stats: IPublicStat<ExpertStatKey>[];
}) {
  return (
    // `/` is a transparent-navbar route (lib/navigation/public-chrome.ts), so
    // the hero supplies its own clearance for the fixed header.
    <section className="relative overflow-hidden pb-24 pt-[calc(var(--header-height)+4rem)] md:pb-32 lg:pt-[calc(var(--header-height)+6rem)]">
      {/* Background: a single soft top light and a faint fading grid. No
          animated blobs — the page should feel still and confident. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_70%_50%_at_50%_-5%,rgba(255,255,255,0.10),transparent_70%)]"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.35] [background-image:linear-gradient(to_right,rgba(255,255,255,0.05)_1px,transparent_1px),linear-gradient(to_bottom,rgba(255,255,255,0.05)_1px,transparent_1px)] [background-size:64px_64px] [mask-image:radial-gradient(ellipse_60%_60%_at_50%_0%,black,transparent)]"
      />

      <div className={cn(container, "relative")}>
        <div className="grid items-center gap-16 lg:grid-cols-[1.1fr_1fr] lg:gap-20">
          {/* Copy */}
          <div>
            <motion.div
              variants={reveal}
              initial="hidden"
              animate="visible"
              transition={revealTransition(0)}
              className="mb-8 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] py-1.5 pl-2 pr-4 text-sm text-zinc-300"
            >
              <span className="flex h-5 w-5 items-center justify-center rounded-full bg-white/10">
                <BadgeCheck className="h-3.5 w-3.5" />
              </span>
              {/* #1490 — was "Trusted by 10,000+ professionals worldwide", a
                  number nothing produced. What replaces it is enforced by the
                  directory reads themselves: only VERIFIED profiles are public. */}
              Every expert is verified before they are listed
            </motion.div>

            <motion.h1
              variants={reveal}
              initial="hidden"
              animate="visible"
              transition={revealTransition(0.06)}
              className="font-serif text-5xl leading-[1.02] tracking-tight text-white sm:text-6xl lg:text-7xl"
            >
              Learn from the <em className="italic text-zinc-300">best minds</em>{" "}
              <span className="text-zinc-400">in your industry.</span>
            </motion.h1>

            <motion.p
              variants={reveal}
              initial="hidden"
              animate="visible"
              transition={revealTransition(0.12)}
              className="mt-6 max-w-xl text-lg leading-relaxed text-zinc-400"
            >
              Personal 1-on-1 sessions, mentorship, classes and live webinars
              with verified practitioners — booked, paid and held in one place.
            </motion.p>

            <motion.div
              variants={reveal}
              initial="hidden"
              animate="visible"
              transition={revealTransition(0.18)}
              className="mt-10 flex flex-col gap-3 sm:flex-row"
            >
              <Button
                asChild
                size="lg"
                className="group h-12 rounded-full bg-white px-6 text-[15px] font-medium text-zinc-950 hover:bg-zinc-200"
              >
                <Link href="/explore/experts">
                  Find your expert
                  <ArrowRight className="ml-1.5 h-4 w-4 transition-transform group-hover:translate-x-0.5" />
                </Link>
              </Button>
              {/* The supply-side CTA lives here now that the navbar carries no
                  CTAs. */}
              <Button
                asChild
                size="lg"
                variant="outline"
                className="h-12 rounded-full border-white/15 bg-white/[0.03] px-6 text-[15px] text-white hover:bg-white/[0.08] hover:text-white"
              >
                <Link href="/become-an-expert">Become an expert</Link>
              </Button>
            </motion.div>

            {/* #1490 — every figure is read from the database, and a figure
                that is still zero produces no tile at all. With no data the
                whole row is absent so there's no stray divider. */}
            {stats.length > 0 && (
              <motion.dl
                variants={reveal}
                initial="hidden"
                animate="visible"
                transition={revealTransition(0.24)}
                className="mt-14 flex flex-wrap gap-x-10 gap-y-6 border-t border-white/[0.08] pt-8"
              >
                {stats.map((stat) => (
                  <div key={stat.key}>
                    <dt className="text-sm text-zinc-400">{stat.label}</dt>
                    <dd className="mt-1 font-serif text-4xl tabular-nums text-white">
                      {stat.display}
                    </dd>
                  </div>
                ))}
              </motion.dl>
            )}
          </div>

          {/* Visual */}
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={revealTransition(0.2)}
          >
            <ProductPreview />
          </motion.div>
        </div>
      </div>
    </section>
  );
}
