"use client";

import { motion } from "framer-motion";
import {
  ArrowUpRight,
  Building2,
  CalendarDays,
  Clock3,
  GraduationCap,
  Play,
  Search,
  ShieldCheck,
  Users,
} from "lucide-react";
import Link from "next/link";

const FILTERS = ["Product", "Engineering", "Leadership", "Design"];

export function FeaturesSection() {
  return (
    <section className="bg-background py-20 md:py-28">
      <div className="mx-auto max-w-[1400px] px-4 md:px-8 lg:px-12">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.45 }}
          className="mb-12 flex flex-col justify-between gap-6 md:flex-row md:items-end"
        >
          <div className="max-w-3xl">
            <p className="mb-3 text-sm font-semibold uppercase tracking-[0.2em] text-muted-foreground">
              Explore Familiarise
            </p>
            <h2 className="text-fluid-4xl font-bold tracking-tight text-foreground md:text-fluid-5xl">
              One marketplace. More ways to learn.
            </h2>
          </div>
          <p className="max-w-md text-fluid-base leading-relaxed text-muted-foreground md:text-right">
            Start with a person, a topic, or a format. Every route takes you to
            real public inventory—not a lead form or a dead end.
          </p>
        </motion.div>

        <div className="grid gap-5 lg:grid-cols-12">
          <motion.article
            initial={{ opacity: 0, y: 24 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.45 }}
            className="group relative overflow-hidden rounded-[2rem] bg-zinc-950 p-7 text-white lg:col-span-7 md:p-10"
          >
            <div className="grid-pattern pointer-events-none absolute inset-0 opacity-30" />
            <div className="absolute -right-20 -top-20 h-80 w-80 rounded-full bg-zinc-700/30 blur-3xl" />
            <div className="relative flex min-h-[420px] flex-col">
              <div className="flex items-start justify-between gap-6">
                <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-white/10 bg-white/10">
                  <Users className="h-6 w-6" />
                </div>
                <div className="inline-flex items-center gap-2 rounded-full border border-white/10 px-3 py-1.5 text-xs text-zinc-400">
                  <ShieldCheck className="h-3.5 w-3.5" />
                  Verified profiles
                </div>
              </div>

              <div className="mt-12 max-w-xl">
                <p className="text-sm font-medium text-zinc-500">
                  Expert directory
                </p>
                <h3 className="mt-2 text-3xl font-bold tracking-tight md:text-4xl">
                  Find someone who has solved it before.
                </h3>
                <p className="mt-4 max-w-lg leading-relaxed text-zinc-400">
                  Compare experience, expertise, ratings, formats, and pricing
                  before you book.
                </p>
              </div>

              <div className="mt-auto pt-10">
                <div className="mb-3 flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.06] p-3 text-sm text-zinc-400">
                  <Search className="h-4 w-4" />
                  Search by skill, industry, or name
                </div>
                <div className="flex flex-wrap gap-2">
                  {FILTERS.map((filter) => (
                    <span
                      key={filter}
                      className="rounded-full bg-white/[0.07] px-3 py-1.5 text-xs text-zinc-300"
                    >
                      {filter}
                    </span>
                  ))}
                </div>
              </div>

              <Link
                href="/explore/experts"
                aria-label="Explore verified experts"
                className="absolute inset-0 rounded-[2rem] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-4"
              />
              <ArrowUpRight className="pointer-events-none absolute bottom-8 right-8 h-6 w-6 transition-transform duration-300 group-hover:-translate-y-1 group-hover:translate-x-1" />
            </div>
          </motion.article>

          <motion.article
            initial={{ opacity: 0, y: 24 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.45, delay: 0.06 }}
            className="group relative overflow-hidden rounded-[2rem] border border-border bg-card p-7 lg:col-span-5 md:p-10"
          >
            <div className="dot-pattern-light pointer-events-none absolute inset-0 opacity-40 dark:opacity-10" />
            <div className="relative flex min-h-[420px] flex-col">
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary text-primary-foreground">
                <GraduationCap className="h-6 w-6" />
              </div>
              <p className="mt-12 text-sm font-medium text-muted-foreground">
                Classes & webinars
              </p>
              <h3 className="mt-2 text-3xl font-bold tracking-tight text-foreground">
                Learn live, with room to ask why.
              </h3>
              <p className="mt-4 leading-relaxed text-muted-foreground">
                Join focused cohorts and interactive sessions led by working
                professionals.
              </p>

              <div className="mt-auto space-y-2 pt-10">
                <div className="flex items-center justify-between rounded-xl border border-border bg-background p-4">
                  <span className="flex items-center gap-3 text-sm font-medium text-foreground">
                    <CalendarDays className="h-4 w-4 text-muted-foreground" />
                    Multi-session classes
                  </span>
                  <ArrowUpRight className="h-4 w-4 text-muted-foreground" />
                </div>
                <div className="flex items-center justify-between rounded-xl border border-border bg-background p-4">
                  <span className="flex items-center gap-3 text-sm font-medium text-foreground">
                    <Users className="h-4 w-4 text-muted-foreground" />
                    Live webinars
                  </span>
                  <ArrowUpRight className="h-4 w-4 text-muted-foreground" />
                </div>
              </div>
              <Link
                href="/explore/programs"
                aria-label="Explore classes and webinars"
                className="absolute inset-0 rounded-[2rem] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-4"
              />
            </div>
          </motion.article>

          <motion.article
            initial={{ opacity: 0, y: 24 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.45 }}
            className="group relative overflow-hidden rounded-[2rem] border border-border bg-zinc-100 p-7 dark:bg-zinc-900 lg:col-span-5 md:p-10"
          >
            <div className="relative flex min-h-[330px] flex-col">
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-white text-zinc-950 shadow-sm dark:bg-zinc-950 dark:text-white">
                <Building2 className="h-6 w-6" />
              </div>
              <p className="mt-10 text-sm font-medium text-muted-foreground">
                Organisations
              </p>
              <h3 className="mt-2 text-3xl font-bold tracking-tight text-foreground">
                Discover trusted expert networks.
              </h3>
              <p className="mt-4 leading-relaxed text-muted-foreground">
                Browse agencies, institutions, and curated expert communities.
              </p>
              <div className="mt-auto flex flex-wrap gap-2 pt-8">
                {["Expert networks", "Agencies", "Institutions"].map(
                  (label) => (
                    <span
                      key={label}
                      className="rounded-full border border-border bg-background px-3 py-1.5 text-xs text-muted-foreground"
                    >
                      {label}
                    </span>
                  ),
                )}
              </div>
              <Link
                href="/explore/enterprise/organisations"
                aria-label="Explore organisations"
                className="absolute inset-0 rounded-[2rem] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-4"
              />
              <ArrowUpRight className="pointer-events-none absolute bottom-1 right-1 h-6 w-6 text-muted-foreground transition-transform duration-300 group-hover:-translate-y-1 group-hover:translate-x-1" />
            </div>
          </motion.article>

          <motion.article
            initial={{ opacity: 0, y: 24 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.45, delay: 0.06 }}
            className="group relative overflow-hidden rounded-[2rem] bg-zinc-900 p-7 text-white lg:col-span-7 md:p-10"
          >
            <div className="absolute right-8 top-8 h-40 w-64 rotate-6 rounded-2xl border border-white/10 bg-gradient-to-br from-zinc-700 to-black opacity-70 transition-transform duration-500 group-hover:rotate-3" />
            <div className="absolute right-16 top-16 flex h-16 w-16 items-center justify-center rounded-full bg-white text-zinc-950 shadow-xl">
              <Play className="ml-1 h-6 w-6 fill-current" />
            </div>
            <div className="relative flex min-h-[330px] max-w-md flex-col">
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-white/10 bg-white/10">
                <Play className="h-5 w-5" />
              </div>
              <p className="mt-10 text-sm font-medium text-zinc-500">
                Recordings library
              </p>
              <h3 className="mt-2 text-3xl font-bold tracking-tight">
                Keep learning after the live session ends.
              </h3>
              <p className="mt-4 leading-relaxed text-zinc-400">
                Buy published class and webinar replays once, then watch them on
                your own schedule.
              </p>
              <div className="mt-auto flex items-center gap-2 pt-8 text-sm text-zinc-400">
                <Clock3 className="h-4 w-4" />
                On-demand access
              </div>
              <Link
                href="/explore/recordings"
                aria-label="Explore session recordings"
                className="absolute inset-0 rounded-[2rem] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-4"
              />
              <ArrowUpRight className="pointer-events-none absolute bottom-1 right-1 h-6 w-6 transition-transform duration-300 group-hover:-translate-y-1 group-hover:translate-x-1" />
            </div>
          </motion.article>
        </div>
      </div>
    </section>
  );
}
