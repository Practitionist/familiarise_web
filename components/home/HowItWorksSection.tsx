"use client";

import { motion } from "framer-motion";
import { ArrowRight, Check, Search, Video } from "lucide-react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { HOW_IT_WORKS } from "./data";

const STEP_ICONS = [Search, Check, Video];

export function HowItWorksSection() {
  return (
    <section
      id="how-it-works"
      className="relative scroll-mt-20 overflow-hidden bg-zinc-950 py-20 text-white md:py-28"
    >
      <div className="grid-pattern pointer-events-none absolute inset-0 opacity-30" />
      <div className="absolute left-1/3 top-0 h-96 w-96 rounded-full bg-zinc-700/20 blur-[120px]" />

      <div className="relative mx-auto max-w-[1400px] px-4 md:px-8 lg:px-12">
        <div className="grid gap-12 lg:grid-cols-[0.75fr_1.25fr] lg:gap-16">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.45 }}
            className="lg:sticky lg:top-32 lg:self-start"
          >
            <p className="mb-3 text-sm font-semibold uppercase tracking-[0.2em] text-zinc-500">
              How it works
            </p>
            <h2 className="text-fluid-4xl font-bold tracking-tight md:text-fluid-5xl">
              From question to conversation.
            </h2>
            <p className="mt-5 max-w-lg text-fluid-base leading-relaxed text-zinc-400">
              Familiarise keeps discovery, booking, payment, and the session in
              one clear flow—so you can focus on the help you came for.
            </p>
            <Button
              asChild
              size="lg"
              className="mt-8 bg-white text-zinc-950 hover:bg-zinc-200"
            >
              <Link href="/explore/experts">
                Find an expert
                <ArrowRight className="ml-2 h-4 w-4" />
              </Link>
            </Button>
          </motion.div>

          <ol className="space-y-3">
            {HOW_IT_WORKS.map((step, index) => {
              const Icon = STEP_ICONS[index];
              return (
                <motion.li
                  key={step.step}
                  initial={{ opacity: 0, x: 20 }}
                  whileInView={{ opacity: 1, x: 0 }}
                  viewport={{ once: true }}
                  transition={{ duration: 0.45, delay: index * 0.08 }}
                  className="grid gap-5 rounded-2xl border border-white/10 bg-white/[0.045] p-6 backdrop-blur-sm sm:grid-cols-[auto_1fr_auto] sm:items-center md:p-8"
                >
                  <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-white text-zinc-950">
                    <Icon className="h-5 w-5" />
                  </div>
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.16em] text-zinc-500">
                      Step {step.step}
                    </p>
                    <h3 className="mt-1 text-xl font-semibold">{step.title}</h3>
                    <p className="mt-2 max-w-xl text-sm leading-relaxed text-zinc-400">
                      {step.description}
                    </p>
                  </div>
                  <span className="hidden text-4xl font-bold text-white/10 sm:block">
                    0{step.step}
                  </span>
                </motion.li>
              );
            })}
          </ol>
        </div>
      </div>
    </section>
  );
}
