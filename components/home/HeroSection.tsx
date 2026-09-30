"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { motion, useInView } from "framer-motion";
import {
  ArrowRight,
  BadgeCheck,
  Calendar,
  Lock,
  Search,
  Sparkles,
  Video,
} from "lucide-react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import type { ExpertStatKey, IPublicStat } from "@/lib/data/public-stats";

const QUICK_DOMAINS = [
  "Technology",
  "Business",
  "Design",
  "Career Coach",
  "Startups",
];

const PREVIEW_FORMATS = [
  { label: "1:1 Consultation", meta: "45 min • Live HD video", active: true },
  { label: "Mentorship Plan", meta: "Weekly calls + async chat", active: false },
  { label: "Cohort Class", meta: "Multi-week structured curriculum", active: false },
];

const PREVIEW_SLOTS = ["Today, 6:00 PM", "Tomorrow, 11:00 AM", "Thu, 4:30 PM"];

function AnimatedNumber({
  value,
  suffix = "",
}: {
  value: number;
  suffix?: string;
}) {
  const ref = useRef(null);
  const isInView = useInView(ref, { once: true });
  const [displayValue, setDisplayValue] = useState(0);

  const animate = useCallback(() => {
    const duration = 1400;
    const steps = 45;
    const increment = value / steps;
    let current = 0;
    const timer = setInterval(() => {
      current += increment;
      if (current >= value) {
        setDisplayValue(value);
        clearInterval(timer);
      } else {
        setDisplayValue(Math.floor(current));
      }
    }, duration / steps);
    return () => clearInterval(timer);
  }, [value]);

  useEffect(() => {
    if (isInView) {
      return animate();
    }
  }, [isInView, animate]);

  return (
    <span
      ref={ref}
      className="text-3xl md:text-4xl font-bold text-white tabular-nums tracking-tight"
    >
      {value % 1 !== 0
        ? displayValue.toFixed(1)
        : displayValue.toLocaleString()}
      {suffix}
    </span>
  );
}

export function HeroSection({
  stats,
}: {
  stats: IPublicStat<ExpertStatKey>[];
}) {
  return (
    <section className="relative bg-zinc-950 text-white pt-32 pb-20 md:pb-28 overflow-hidden">
      {/* Subtle radial spotlight + grid pattern */}
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_80%_50%_at_50%_-20%,rgba(255,255,255,0.08),transparent)]" />
      <div className="pointer-events-none absolute inset-0 grid-pattern opacity-20" />

      <div className="max-w-[1400px] mx-auto px-4 sm:px-8 xl:px-12 relative z-10">
        <div className="grid lg:grid-cols-12 gap-12 lg:gap-10 items-center">
          {/* Left column: Headline, Inline Search, Domain Pills & Verified Stats */}
          <div className="lg:col-span-7">
            <motion.div
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.45 }}
              className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-white/[0.06] border border-white/10 text-zinc-300 text-xs font-medium mb-6"
            >
              <Sparkles className="w-3.5 h-3.5 text-zinc-300" />
              {/* #1490 — enforced by the directory reads themselves: only VERIFIED profiles are public. */}
              <span>Every expert is verified before they are listed</span>
            </motion.div>

            <motion.h1
              initial={{ opacity: 0, y: 18 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, delay: 0.05 }}
              className="text-fluid-4xl md:text-fluid-5xl font-bold text-white mb-6 leading-[1.08] tracking-tight"
            >
              Learn directly from the{" "}
              <span className="silver-text">best minds</span>{" "}
              <span className="text-zinc-400">in your industry</span>
            </motion.h1>

            <motion.p
              initial={{ opacity: 0, y: 18 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, delay: 0.1 }}
              className="text-base md:text-lg text-zinc-400 mb-8 max-w-2xl leading-relaxed"
            >
              Book 1-on-1 consultations, ongoing mentorship subscriptions,
              cohort classes, and live webinars with verified practitioners —
              backed by built-in HD video and escrow payment protection.
            </motion.p>

            {/* Interactive Search Bar */}
            <motion.form
              initial={{ opacity: 0, y: 18 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, delay: 0.15 }}
              action="/explore/experts"
              method="GET"
              className="mb-5 max-w-2xl"
            >
              <div className="flex flex-col sm:flex-row gap-2.5 p-2 rounded-2xl bg-zinc-900/90 border border-white/10 focus-within:border-white/25 transition-colors shadow-xl">
                <div className="relative flex-1 flex items-center">
                  <Search className="w-4 h-4 text-zinc-400 ml-3.5 shrink-0" />
                  <input
                    type="text"
                    name="search"
                    aria-label="Search experts by skill, role, or topic"
                    placeholder="Search by skill, role, domain, or company..."
                    className="w-full bg-transparent px-3 py-2.5 text-sm text-white placeholder:text-zinc-500 focus:outline-none"
                  />
                </div>
                <Button
                  type="submit"
                  size="lg"
                  className="h-11 px-6 rounded-xl bg-white text-zinc-900 hover:bg-zinc-100 font-medium shrink-0"
                >
                  Explore Experts
                  <ArrowRight className="ml-2 w-4 h-4" />
                </Button>
              </div>
            </motion.form>

            {/* Popular Domain Pills & Secondary Actions */}
            <motion.div
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, delay: 0.2 }}
              className="flex flex-wrap items-center gap-2 mb-10"
            >
              <span className="text-xs font-medium text-zinc-500 mr-1">
                Popular domains:
              </span>
              {QUICK_DOMAINS.map((domain) => (
                <Link
                  key={domain}
                  href={`/explore/experts?domain=${encodeURIComponent(domain.toLowerCase())}`}
                  className="text-xs px-3 py-1.5 rounded-full border border-white/10 bg-white/[0.03] text-zinc-300 hover:bg-white/[0.08] hover:text-white hover:border-white/20 transition-colors"
                >
                  {domain}
                </Link>
              ))}
              <Link
                href="/become-an-expert"
                className="text-xs px-3 py-1.5 rounded-full text-zinc-400 hover:text-white underline underline-offset-4 ml-1 transition-colors"
              >
                Become an Expert →
              </Link>
            </motion.div>

            {/* Real Database Stats (#1490) */}
            {stats.length > 0 && (
              <motion.dl
                initial={{ opacity: 0, y: 16 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.5, delay: 0.25 }}
                className="grid grid-cols-2 sm:grid-cols-3 gap-6 pt-8 border-t border-white/[0.08] max-w-xl"
              >
                {stats.map((stat) => (
                  <div key={stat.key}>
                    <dd>
                      <AnimatedNumber value={stat.value} />
                    </dd>
                    <dt className="text-xs text-zinc-400 mt-1 font-medium">
                      {stat.label}
                    </dt>
                  </div>
                ))}
              </motion.dl>
            )}
          </div>

          {/* Right column: Interactive Session & Booking Architecture Preview */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.55, delay: 0.15 }}
            className="lg:col-span-5"
          >
            <div className="rounded-2xl border border-white/10 bg-zinc-900/70 backdrop-blur-md p-6 shadow-2xl">
              {/* Header bar */}
              <div className="flex items-center justify-between pb-5 mb-5 border-b border-white/[0.08]">
                <div className="flex items-center gap-3">
                  <div className="w-11 h-11 rounded-xl bg-zinc-800 border border-white/10 flex items-center justify-center font-semibold text-sm text-white">
                    1:1
                  </div>
                  <div>
                    <div className="flex items-center gap-1.5">
                      <span className="text-sm font-semibold text-white">
                        Verified Expert Session
                      </span>
                      <BadgeCheck className="w-4 h-4 text-emerald-400 shrink-0" />
                    </div>
                    <p className="text-xs text-zinc-400">
                      Architecture, Career &amp; Product Advisory
                    </p>
                  </div>
                </div>
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-emerald-300 text-xs font-medium">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                  Available
                </span>
              </div>

              {/* Session Format Selector Preview */}
              <div className="space-y-2.5 mb-5">
                <p className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
                  Choose Your Format
                </p>
                {PREVIEW_FORMATS.map((item) => (
                  <div
                    key={item.label}
                    className={`flex items-center justify-between p-3 rounded-xl border transition-colors ${
                      item.active
                        ? "border-white/25 bg-white/[0.06]"
                        : "border-white/[0.06] bg-zinc-950/50"
                    }`}
                  >
                    <div>
                      <p className="text-sm font-medium text-white">
                        {item.label}
                      </p>
                      <p className="text-xs text-zinc-400">{item.meta}</p>
                    </div>
                    <span
                      className={`text-xs px-2.5 py-1 rounded-md font-medium ${
                        item.active
                          ? "bg-white text-zinc-950"
                          : "bg-zinc-800 text-zinc-400"
                      }`}
                    >
                      {item.active ? "Selected" : "Available"}
                    </span>
                  </div>
                ))}
              </div>

              {/* Next Available Slots */}
              <div className="mb-6">
                <div className="flex items-center justify-between text-xs text-zinc-400 mb-2.5">
                  <span className="flex items-center gap-1.5 font-medium text-zinc-300">
                    <Calendar className="w-3.5 h-3.5 text-zinc-400" />
                    Instant Timezone-Aware Slots
                  </span>
                  <span>Auto-detected</span>
                </div>
                <div className="grid grid-cols-3 gap-2">
                  {PREVIEW_SLOTS.map((slot, idx) => (
                    <div
                      key={slot}
                      className={`text-center py-2 px-2 rounded-lg border text-xs font-medium ${
                        idx === 0
                          ? "border-white/30 bg-white/10 text-white"
                          : "border-white/[0.08] bg-zinc-950/60 text-zinc-400"
                      }`}
                    >
                      {slot}
                    </div>
                  ))}
                </div>
              </div>

              {/* Built-in Platform Guarantees Footer */}
              <div className="grid grid-cols-2 gap-3 pt-4 border-t border-white/[0.08] mb-5">
                <div className="flex items-center gap-2 text-xs text-zinc-300">
                  <Video className="w-4 h-4 text-zinc-400 shrink-0" />
                  <span>Browser HD Video &amp; Recording</span>
                </div>
                <div className="flex items-center gap-2 text-xs text-zinc-300">
                  <Lock className="w-4 h-4 text-zinc-400 shrink-0" />
                  <span>Escrow Payment Protection</span>
                </div>
              </div>

              <div className="flex flex-col sm:flex-row gap-2.5">
                <Button
                  asChild
                  className="flex-1 h-11 rounded-xl bg-white text-zinc-900 hover:bg-zinc-100 font-medium"
                >
                  <Link href="/explore/experts">
                    Browse 1:1 Experts
                    <ArrowRight className="ml-1.5 w-4 h-4" />
                  </Link>
                </Button>
                <Button
                  asChild
                  variant="outline"
                  className="h-11 rounded-xl border-white/15 bg-white/[0.04] text-white hover:bg-white/10 hover:text-white"
                >
                  <Link href="/explore/programs">Cohort Programs</Link>
                </Button>
              </div>
            </div>
          </motion.div>
        </div>
      </div>
    </section>
  );
}
