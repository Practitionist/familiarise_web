"use client";

import { motion } from "framer-motion";

import { RevealGroup, RevealItem, SpotlightGrid } from "@/components/motion";
import { Badge } from "@/components/ui/badge";
import { HOW_IT_WORKS } from "./data";

/**
 * How it works — a numbered progress line across a dark stage. The connector
 * draws itself as the steps scroll into view; each step lifts its number chip
 * on hover.
 */
export function HowItWorksSection() {
  return (
    <section className="bg-obsidian relative overflow-hidden py-20 md:py-28">
      <SpotlightGrid className="opacity-50" />
      <div className="container mx-auto px-4 md:px-6 relative z-10">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
          viewport={{ once: true }}
          className="mb-14 text-center"
        >
          <Badge
            variant="secondary"
            className="mb-4 rounded-full border-zinc-800 bg-zinc-800/60 text-zinc-300 hover:bg-zinc-800"
          >
            How it works
          </Badge>
          <h2 className="text-fluid-4xl font-bold tracking-tight text-white text-balance">
            From browsing to breakthrough in{" "}
            <span className="silver-text">four steps</span>
          </h2>
        </motion.div>

        <RevealGroup
          stagger={0.12}
          className="relative grid gap-10 sm:grid-cols-2 lg:grid-cols-4 lg:gap-8"
        >
          {/* Connector line (desktop) */}
          <div
            aria-hidden
            className="absolute left-0 right-0 top-6 hidden h-px bg-gradient-to-r from-transparent via-white/15 to-transparent lg:block"
          />
          {HOW_IT_WORKS.map((step) => (
            <RevealItem key={step.step}>
              <div className="group relative">
                <div className="mb-6 flex items-center gap-3 lg:flex-col lg:items-start">
                  <span className="flex h-12 w-12 items-center justify-center rounded-full border border-white/15 bg-zinc-900 font-mono text-sm text-white transition-all duration-500 group-hover:border-white group-hover:bg-white group-hover:text-black">
                    {step.step}
                  </span>
                  <span className="h-px flex-1 bg-white/10 lg:hidden" />
                </div>
                <h4 className="text-lg font-semibold tracking-tight text-white transition-transform duration-500 ease-[cubic-bezier(0.16,1,0.3,1)] group-hover:-translate-y-1">
                  {step.title}
                </h4>
                <p className="mt-2 max-w-xs leading-relaxed text-zinc-500">
                  {step.description}
                </p>
              </div>
            </RevealItem>
          ))}
        </RevealGroup>
      </div>
    </section>
  );
}
