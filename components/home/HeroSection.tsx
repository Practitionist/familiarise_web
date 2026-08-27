"use client";

import { motion } from "framer-motion";
import { ArrowRight, Sparkles } from "lucide-react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import {
  AnimatedNumber,
  MarqueeRow,
  SpotlightGrid,
  wordRevealChild,
  wordRevealParent,
} from "@/components/motion";
import { COMPANY_LOGOS, STATS } from "./data";

/**
 * Hero — full-viewport black stage with a cursor-following spotlight grid.
 * The headline rises word-by-word from a clipped line (SSR-safe: words are
 * split at module scope, not in an effect), stats count up on load, and the
 * trusted-by logo cloud rides a marquee along the bottom edge.
 */
export function HeroSection() {
  const headlineTop = ["Learn", "from", "the"];
  const headlineAccent = ["best", "minds"];
  const headlineBottom = ["in", "your", "industry"];

  return (
    <section className="relative min-h-[100svh] flex flex-col bg-black overflow-hidden">
      {/* Interactive backdrop */}
      <SpotlightGrid className="opacity-70" />
      <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/20 to-transparent" />
      <div
        aria-hidden
        className="pointer-events-none absolute -top-40 left-1/2 h-[480px] w-[820px] -translate-x-1/2 rounded-full bg-zinc-500/10 blur-[140px]"
      />

      <div className="flex-1 flex items-center">
        <div className="container mx-auto px-4 md:px-6 relative z-10 py-28 md:py-32 w-full">
          <div className="max-w-4xl mx-auto text-center">
            {/* Availability pill */}
            <motion.div
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5 }}
              className="inline-flex items-center gap-2.5 px-4 py-1.5 rounded-full border border-white/10 bg-white/[0.04] text-sm text-zinc-300 mb-10"
            >
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-60 animate-ping" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-400" />
              </span>
              Mentors available this week
            </motion.div>

            {/* Headline — word-by-word clip reveal */}
            <motion.h1
              variants={wordRevealParent}
              initial="hidden"
              animate="visible"
              className="text-fluid-5xl font-bold text-white leading-[1.05] tracking-tight mb-6"
              aria-label="Learn from the best minds in your industry"
            >
              {[headlineTop, headlineAccent, headlineBottom].map(
                (words, lineIdx) => (
                  <span key={lineIdx} className="block overflow-hidden pb-1">
                    {lineIdx === 2 && (
                      <span className="sr-only">in your industry</span>
                    )}
                    {words.map((word, wordIdx) => (
                      <span
                        key={word}
                        aria-hidden="true"
                        className="inline-block overflow-hidden align-bottom"
                      >
                        <motion.span
                          variants={wordRevealChild}
                          className={`inline-block will-change-transform ${
                            lineIdx === 1 ? "silver-text" : ""
                          }`}
                        >
                          {word}
                          {wordIdx < words.length - 1 ? "\u00A0" : ""}
                        </motion.span>
                      </span>
                    ))}
                  </span>
                ),
              )}
            </motion.h1>

            {/* Subheadline */}
            <motion.p
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, delay: 0.55, ease: [0.16, 1, 0.3, 1] }}
              className="text-lg md:text-xl text-zinc-400 mb-12 max-w-xl mx-auto leading-relaxed"
            >
              1-on-1 sessions, interactive classes, and live webinars with
              verified experts — your career transformation starts here.
            </motion.p>

            {/* CTAs */}
            <motion.div
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, delay: 0.7, ease: [0.16, 1, 0.3, 1] }}
              className="flex flex-col sm:flex-row items-center justify-center gap-4 mb-20"
            >
              <Button
                size="lg"
                className="sheen group relative h-14 px-9 rounded-full bg-white text-black hover:bg-zinc-200 text-base font-medium shadow-[0_8px_40px_-8px_rgba(255,255,255,0.35)]"
                asChild
              >
                <Link href="/explore/experts">
                  Find Your Expert
                  <ArrowRight className="ml-2 w-4 h-4 group-hover:translate-x-1 transition-transform" />
                </Link>
              </Button>
              <Button
                size="lg"
                variant="outline"
                className="h-14 px-9 rounded-full border-zinc-800 bg-transparent text-zinc-200 hover:bg-zinc-900 hover:text-white hover:border-zinc-600 text-base"
                asChild
              >
                <Link href="/become-an-expert">Become an Expert</Link>
              </Button>
            </motion.div>

            {/* Stats strip */}
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.8, delay: 0.85 }}
              className="grid grid-cols-2 md:grid-cols-4 gap-8 pt-10 border-t border-white/[0.07]"
            >
              {STATS.map((stat) => (
                <div key={stat.label} className="text-center">
                  <AnimatedNumber
                    value={stat.value}
                    suffix={stat.suffix}
                    decimals={Number.isInteger(stat.value) ? 0 : 1}
                    className="text-3xl md:text-4xl font-semibold text-white tabular-nums"
                  />
                  <div className="text-zinc-500 text-sm mt-1.5 tracking-wide uppercase text-xs">
                    {stat.label}
                  </div>
                </div>
              ))}
            </motion.div>
          </div>
        </div>
      </div>

      {/* Trusted-by marquee pinned to the hero's base */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.8, delay: 1 }}
        className="relative z-10 pb-10"
      >
        <p className="text-center text-xs uppercase tracking-[0.25em] text-zinc-600 mb-5 flex items-center justify-center gap-2">
          <Sparkles className="w-3.5 h-3.5" />
          Mentors from
        </p>
        <MarqueeRow duration={32} className="[&_span]:text-zinc-600 [&_span]:hover:text-zinc-300">
          {COMPANY_LOGOS.map((logo) => (
            <span
              key={logo}
              className="mx-6 text-lg font-semibold tracking-tight whitespace-nowrap transition-colors duration-300 cursor-default"
            >
              {logo}
            </span>
          ))}
        </MarqueeRow>
      </motion.div>

      {/* Bottom fade into the offerings band */}
      <div className="absolute bottom-0 left-0 right-0 h-24 bg-gradient-to-t from-zinc-950 to-transparent pointer-events-none" />
    </section>
  );
}
