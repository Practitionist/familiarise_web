"use client";

import { motion } from "framer-motion";
import {
  ArrowRight,
  Building2,
  CalendarDays,
  CircleDollarSign,
  Users,
} from "lucide-react";
import Link from "next/link";

import { Button } from "@/components/ui/button";

const ORGANISATION_POINTS = [
  { icon: Users, label: "Team learning and mentorship" },
  { icon: Building2, label: "Procurement-ready billing" },
];

const EXPERT_POINTS = [
  { icon: CalendarDays, label: "Set your own availability" },
  { icon: CircleDollarSign, label: "Choose your formats and rates" },
];

export function NextStepSection() {
  return (
    <section className="bg-zinc-100 py-20 dark:bg-zinc-950 md:py-28">
      <div className="mx-auto max-w-[1400px] px-4 md:px-8 lg:px-12">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.45 }}
          className="mb-10 max-w-2xl"
        >
          <p className="mb-3 text-sm font-semibold uppercase tracking-[0.2em] text-muted-foreground">
            Build with Familiarise
          </p>
          <h2 className="text-fluid-4xl font-bold tracking-tight text-foreground">
            Expertise works both ways.
          </h2>
          <p className="mt-4 text-fluid-lg text-muted-foreground">
            Bring trusted learning to your organisation, or turn the experience
            you already have into something others can learn from.
          </p>
        </motion.div>

        <div className="grid gap-5 lg:grid-cols-2">
          <motion.article
            initial={{ opacity: 0, y: 24 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.45 }}
            className="relative overflow-hidden rounded-[2rem] bg-zinc-950 p-7 text-white md:p-10"
          >
            <div className="grid-pattern pointer-events-none absolute inset-0 opacity-30" />
            <div className="absolute -right-20 -top-20 h-72 w-72 rounded-full bg-zinc-700/30 blur-3xl" />
            <div className="relative">
              <div className="mb-12 flex h-12 w-12 items-center justify-center rounded-2xl border border-white/10 bg-white/10">
                <Building2 className="h-6 w-6" />
              </div>
              <p className="mb-2 text-sm font-medium text-zinc-400">
                For organisations
              </p>
              <h3 className="max-w-lg text-2xl font-bold tracking-tight md:text-3xl">
                Give your people access to the right experts.
              </h3>
              <div className="my-8 grid gap-3 sm:grid-cols-2">
                {ORGANISATION_POINTS.map((point) => (
                  <div
                    key={point.label}
                    className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/[0.04] p-3 text-sm text-zinc-300"
                  >
                    <point.icon className="h-4 w-4 shrink-0" />
                    {point.label}
                  </div>
                ))}
              </div>
              <Button asChild className="bg-white text-black hover:bg-zinc-200">
                <Link href="/enterprise">
                  Explore enterprise
                  <ArrowRight className="ml-2 h-4 w-4" />
                </Link>
              </Button>
            </div>
          </motion.article>

          <motion.article
            initial={{ opacity: 0, y: 24 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.45, delay: 0.08 }}
            className="relative overflow-hidden rounded-[2rem] border border-border bg-card p-7 md:p-10"
          >
            <div className="dot-pattern-light pointer-events-none absolute inset-0 opacity-50 dark:opacity-10" />
            <div className="relative">
              <div className="mb-12 flex h-12 w-12 items-center justify-center rounded-2xl bg-primary text-primary-foreground">
                <Users className="h-6 w-6" />
              </div>
              <p className="mb-2 text-sm font-medium text-muted-foreground">
                For experts
              </p>
              <h3 className="max-w-lg text-2xl font-bold tracking-tight text-foreground md:text-3xl">
                Make your experience useful to someone else.
              </h3>
              <div className="my-8 grid gap-3 sm:grid-cols-2">
                {EXPERT_POINTS.map((point) => (
                  <div
                    key={point.label}
                    className="flex items-center gap-3 rounded-xl bg-muted p-3 text-sm text-muted-foreground"
                  >
                    <point.icon className="h-4 w-4 shrink-0 text-foreground" />
                    {point.label}
                  </div>
                ))}
              </div>
              <Button asChild>
                <Link href="/become-an-expert">
                  Become an expert
                  <ArrowRight className="ml-2 h-4 w-4" />
                </Link>
              </Button>
            </div>
          </motion.article>
        </div>
      </div>
    </section>
  );
}
