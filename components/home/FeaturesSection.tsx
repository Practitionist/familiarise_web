"use client";

import { motion } from "framer-motion";
import { LucideIcon } from "lucide-react";
import Link from "next/link";

import { RevealGroup, RevealItem } from "@/components/motion";
import { Badge } from "@/components/ui/badge";
import { FEATURES } from "./data";

/** Bento layout: generous half-width cells in a 2×2 arrangement. */
const SPANS = ["", "", "", ""];

function OfferingCell({
  feature,
  index,
}: {
  feature: {
    icon: LucideIcon;
    title: string;
    description: string;
    gradient: string;
  };
  index: number;
}) {
  const Icon = feature.icon;

  return (
    <RevealItem className={SPANS[index % SPANS.length]}>
      <Link
        href={index === 0 ? "/explore/experts" : "/explore/programs"}
        className="group relative flex h-full flex-col justify-between overflow-hidden rounded-2xl border border-white/[0.08] bg-zinc-900/60 p-7 md:p-9 transition-colors duration-500 hover:border-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {/* Hover glow */}
        <div
          aria-hidden
          className="pointer-events-none absolute -inset-24 opacity-0 transition-opacity duration-700 group-hover:opacity-100"
          style={{
            background:
              "radial-gradient(420px circle at 50% 0%, rgba(255,255,255,0.07), transparent 65%)",
          }}
        />

        <div className="relative z-10">
          <div className="flex items-start justify-between">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-white/10 bg-white/[0.04] transition-transform duration-500 group-hover:-translate-y-1 group-hover:scale-105">
              <Icon className="h-5 w-5 text-white" />
            </div>
            <span className="font-mono text-xs text-zinc-600">
              {String(index + 1).padStart(2, "0")}
            </span>
          </div>
          <h3 className="mt-8 text-xl md:text-2xl font-semibold tracking-tight text-white">
            {feature.title}
          </h3>
          <p className="mt-3 max-w-md leading-relaxed text-zinc-400">
            {feature.description}
          </p>
        </div>

        <span
          aria-hidden
          className="mt-8 inline-flex translate-y-1 items-center gap-1 text-sm text-zinc-500 opacity-0 transition-all duration-500 group-hover:translate-y-0 group-hover:text-white group-hover:opacity-100"
        >
          Explore
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path
              d="M3 8h10M9 4l4 4-4 4"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
      </Link>
    </RevealItem>
  );
}

export function FeaturesSection() {
  return (
    <section className="bg-zinc-950 py-20 md:py-28 relative overflow-hidden">
      <div className="container mx-auto px-4 md:px-6 relative z-10">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
          viewport={{ once: true }}
          className="mb-14 flex flex-col gap-6 md:flex-row md:items-end md:justify-between"
        >
          <div className="max-w-xl">
            <Badge
              variant="secondary"
              className="mb-4 rounded-full border-zinc-800 bg-zinc-800/60 text-zinc-300 hover:bg-zinc-800"
            >
              Our Offerings
            </Badge>
            <h2 className="text-fluid-4xl font-bold tracking-tight text-white">
              Four ways to <span className="silver-text">learn &amp; grow</span>
            </h2>
          </div>
          <p className="max-w-sm text-muted-foreground md:text-right">
            Pick the format that fits your learning style and schedule.
          </p>
        </motion.div>

        <RevealGroup
          stagger={0.09}
          className="grid grid-cols-1 gap-4 md:grid-cols-2 md:gap-5"
        >
          {FEATURES.map((feature, index) => (
            <OfferingCell
              key={feature.title}
              feature={feature}
              index={index}
            />
          ))}
        </RevealGroup>
      </div>
    </section>
  );
}
