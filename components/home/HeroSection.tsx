"use client";

import { motion } from "framer-motion";
import {
  ArrowRight,
  BadgeCheck,
  Building2,
  GraduationCap,
  PlayCircle,
  Search,
  Sparkles,
  Users,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import type { ExpertStatKey, IPublicStat } from "@/lib/data/public-stats";

const EXPLORE_PATHS: Array<{
  title: string;
  eyebrow: string;
  href: string;
  icon: LucideIcon;
}> = [
  {
    title: "Book 1:1 guidance",
    eyebrow: "Verified experts",
    href: "/explore/experts",
    icon: Users,
  },
  {
    title: "Join a live program",
    eyebrow: "Classes & webinars",
    href: "/explore/programs",
    icon: GraduationCap,
  },
  {
    title: "Browse expert networks",
    eyebrow: "Organisations",
    href: "/explore/enterprise/organisations",
    icon: Building2,
  },
  {
    title: "Learn on your time",
    eyebrow: "Recorded sessions",
    href: "/explore/recordings",
    icon: PlayCircle,
  },
];

const POPULAR_SEARCHES = ["Technology", "Business", "Creative Arts"];

export function HeroSection({
  stats,
}: {
  stats: IPublicStat<ExpertStatKey>[];
}) {
  return (
    <section className="relative flex min-h-[min(940px,100svh)] items-center overflow-hidden bg-zinc-950 pb-16 pt-28 text-white md:pb-20 md:pt-32">
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute -left-48 top-0 h-[620px] w-[620px] rounded-full bg-zinc-700/20 blur-[140px]" />
        <div className="absolute -right-40 bottom-0 h-[560px] w-[560px] rounded-full bg-zinc-800/40 blur-[130px]" />
        <div className="grid-pattern absolute inset-0 opacity-40" />
        <div className="absolute inset-x-0 bottom-0 h-40 bg-gradient-to-t from-zinc-950 to-transparent" />
      </div>

      <div className="relative z-10 mx-auto w-full max-w-[1500px] px-4 md:px-8 lg:px-12">
        <div className="grid items-center gap-14 lg:grid-cols-[minmax(0,1.08fr)_minmax(420px,0.92fr)] lg:gap-16">
          <div className="max-w-3xl">
            <motion.div
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.45 }}
              className="mb-7 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.06] px-4 py-2 text-sm text-zinc-300 backdrop-blur"
            >
              <BadgeCheck className="h-4 w-4 text-white" />
              Every public expert is verified before listing
            </motion.div>

            <motion.h1
              initial={{ opacity: 0, y: 18 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.55, delay: 0.05 }}
              className="text-[clamp(2.75rem,7vw,6.75rem)] font-bold leading-[0.94] tracking-[-0.055em]"
            >
              Find the person
              <span className="mt-1 block text-zinc-500">
                who gets you unstuck.
              </span>
            </motion.h1>

            <motion.p
              initial={{ opacity: 0, y: 18 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.55, delay: 0.12 }}
              className="mt-7 max-w-2xl text-fluid-lg leading-relaxed text-zinc-400 md:text-xl"
            >
              Get practical guidance from verified professionals, learn live in
              expert-led programs, or explore trusted networks—all in one place.
            </motion.p>

            <motion.form
              action="/explore/experts"
              initial={{ opacity: 0, y: 18 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.55, delay: 0.18 }}
              className="mt-9 flex max-w-2xl flex-col gap-2 rounded-2xl border border-white/10 bg-white p-2 shadow-2xl shadow-black/30 sm:flex-row"
            >
              <label className="flex min-w-0 flex-1 items-center gap-3 px-3">
                <Search className="h-5 w-5 shrink-0 text-zinc-500" />
                <span className="sr-only">Search experts</span>
                <input
                  name="search"
                  type="search"
                  placeholder="Search a skill, industry, or expert"
                  className="h-12 min-w-0 flex-1 bg-transparent text-sm text-zinc-950 outline-none placeholder:text-zinc-500 md:text-base"
                />
              </label>
              <button
                type="submit"
                className="inline-flex h-12 items-center justify-center gap-2 rounded-xl bg-zinc-950 px-5 text-sm font-semibold text-white transition-colors hover:bg-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-500 focus-visible:ring-offset-2"
              >
                Search experts
                <ArrowRight className="h-4 w-4" />
              </button>
            </motion.form>

            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.5, delay: 0.28 }}
              className="mt-4 flex flex-wrap items-center gap-2 text-xs text-zinc-500"
            >
              <span>Popular:</span>
              {POPULAR_SEARCHES.map((term) => (
                <Link
                  key={term}
                  href={`/explore/experts?domain=${encodeURIComponent(term)}`}
                  className="rounded-full border border-white/10 px-3 py-1.5 text-zinc-300 transition-colors hover:border-white/25 hover:bg-white/[0.06]"
                >
                  {term}
                </Link>
              ))}
            </motion.div>

            {stats.length > 0 && (
              <motion.dl
                initial={{ opacity: 0, y: 16 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.55, delay: 0.32 }}
                className="mt-9 flex flex-wrap gap-x-9 gap-y-4 border-t border-white/10 pt-7"
              >
                {stats.map((stat) => (
                  <div key={stat.key}>
                    <dd className="text-2xl font-bold tabular-nums text-white">
                      {stat.display}
                    </dd>
                    <dt className="mt-0.5 text-xs text-zinc-500">
                      {stat.label}
                    </dt>
                  </div>
                ))}
              </motion.dl>
            )}
          </div>

          <motion.aside
            initial={{ opacity: 0, x: 24 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.65, delay: 0.16 }}
            className="relative mx-auto w-full max-w-xl lg:mx-0"
            aria-label="Explore Familiarise"
          >
            <div className="absolute -inset-8 rounded-full bg-white/[0.04] blur-3xl" />
            <div className="relative rounded-[2rem] border border-white/10 bg-white/[0.055] p-3 shadow-2xl shadow-black/30 backdrop-blur-xl md:p-4">
              <div className="mb-2 flex items-center justify-between px-3 py-3">
                <div>
                  <p className="text-sm font-semibold text-white">
                    Start with what you need
                  </p>
                  <p className="mt-1 text-xs text-zinc-500">
                    Four ways to move forward
                  </p>
                </div>
                <Sparkles className="h-5 w-5 text-zinc-500" />
              </div>

              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
                {EXPLORE_PATHS.map((path, index) => (
                  <Link
                    key={path.title}
                    href={path.href}
                    className={`group relative min-h-40 overflow-hidden rounded-2xl border p-5 transition-all duration-300 hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60 ${
                      index === 0
                        ? "border-white bg-white text-zinc-950"
                        : "border-white/10 bg-zinc-900/80 text-white hover:border-white/20 hover:bg-zinc-900"
                    }`}
                  >
                    <div
                      className={`mb-8 flex h-10 w-10 items-center justify-center rounded-xl ${
                        index === 0
                          ? "bg-zinc-950 text-white"
                          : "bg-white/10 text-zinc-300"
                      }`}
                    >
                      <path.icon className="h-5 w-5" />
                    </div>
                    <p className="text-xs text-zinc-500">{path.eyebrow}</p>
                    <div className="mt-1 flex items-end justify-between gap-2">
                      <p className="font-semibold leading-tight">
                        {path.title}
                      </p>
                      <ArrowRight className="h-4 w-4 shrink-0 transition-transform group-hover:translate-x-1" />
                    </div>
                  </Link>
                ))}
              </div>

              <Button
                asChild
                variant="ghost"
                className="mt-2 h-11 w-full text-zinc-300 hover:bg-white/[0.06] hover:text-white"
              >
                <Link href="/explore/experts#all-experts">
                  Browse the full marketplace
                  <ArrowRight className="ml-2 h-4 w-4" />
                </Link>
              </Button>
            </div>
          </motion.aside>
        </div>
      </div>
    </section>
  );
}
