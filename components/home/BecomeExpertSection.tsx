"use client";

import { motion } from "framer-motion";
import { ArrowRight, Clock, Mic, Target } from "lucide-react";
import Link from "next/link";

import { Button } from "@/components/ui/button";

const EXPERT_BENEFITS = [
  { icon: Target, label: "Set Your Own Rates" },
  { icon: Clock, label: "Flexible Availability" },
  { icon: Mic, label: "1:1s, Classes & Webinars" },
];

export function BecomeExpertSection() {
  return (
    <section className="py-20 md:py-28 bg-zinc-950 text-white relative overflow-hidden">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_80%_50%_at_50%_-20%,rgba(255,255,255,0.08),transparent)]" />
      <div className="pointer-events-none absolute inset-0 grid-pattern opacity-20" />

      <div className="max-w-4xl mx-auto px-4 sm:px-8 relative z-10 text-center">
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.45 }}
          viewport={{ once: true }}
        >
          <span className="inline-flex items-center px-3.5 py-1.5 rounded-full bg-white/[0.06] border border-white/10 text-zinc-300 text-xs font-medium mb-6">
            Share Your Expertise
          </span>
          <h2 className="text-fluid-3xl md:text-fluid-4xl font-bold text-white mb-4 tracking-tight">
            Become a verified expert on{" "}
            <span className="silver-text">Familiarise</span>
          </h2>
          <p className="text-base md:text-lg text-zinc-400 mb-8 max-w-2xl mx-auto leading-relaxed">
            Monetize your domain expertise through 1-on-1 consultations,
            mentorship subscriptions, cohort classes, and live webinars — while
            we handle scheduling, video, and global payouts.
          </p>

          <div className="flex flex-wrap items-center justify-center gap-4 sm:gap-8 mb-10">
            {EXPERT_BENEFITS.map((item) => (
              <div
                key={item.label}
                className="inline-flex items-center gap-2 text-sm text-zinc-300"
              >
                <item.icon className="w-4 h-4 text-zinc-400" />
                <span className="font-medium">{item.label}</span>
              </div>
            ))}
          </div>

          <div className="flex flex-col sm:flex-row items-center justify-center gap-3.5">
            <Button
              asChild
              size="lg"
              className="h-12 px-8 rounded-xl bg-white text-zinc-900 hover:bg-zinc-100 font-medium w-full sm:w-auto"
            >
              <Link href="/become-an-expert">
                Apply as an Expert
                <ArrowRight className="ml-2 w-4 h-4" />
              </Link>
            </Button>
            <Button
              asChild
              size="lg"
              variant="outline"
              className="h-12 px-8 rounded-xl border-white/15 bg-white/[0.04] text-white hover:bg-white/10 hover:text-white w-full sm:w-auto"
            >
              <Link href="/explore/experts">Browse Verified Experts</Link>
            </Button>
          </div>
        </motion.div>
      </div>
    </section>
  );
}
