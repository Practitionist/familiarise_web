"use client";

import { motion } from "framer-motion";
import { ArrowRight } from "lucide-react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { HOW_IT_WORKS } from "./data";

export function HowItWorksSection() {
  return (
    <section
      id="how-it-works"
      className="py-20 md:py-28 bg-muted border-b border-border scroll-mt-20"
    >
      <div className="max-w-[1400px] mx-auto px-4 sm:px-8 xl:px-12">
        <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-6 mb-14">
          <div className="max-w-2xl">
            <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground mb-3">
              How It Works
            </p>
            <h2 className="text-fluid-3xl md:text-fluid-4xl font-bold text-foreground tracking-tight mb-3">
              From question to live session in three steps
            </h2>
            <p className="text-base text-muted-foreground leading-relaxed">
              No back-and-forth scheduling threads or manual invoice links. Pick
              a verified specialist, lock your slot in escrow, and meet directly
              in your browser.
            </p>
          </div>
          <Button
            asChild
            size="lg"
            className="h-11 px-6 rounded-xl bg-primary text-primary-foreground hover:bg-primary/90 shrink-0 self-start md:self-auto"
          >
            <Link href="/explore/experts">
              Find Your Expert
              <ArrowRight className="ml-2 w-4 h-4" />
            </Link>
          </Button>
        </div>

        <div className="grid md:grid-cols-3 gap-6">
          {HOW_IT_WORKS.map((item, index) => (
            <motion.div
              key={item.step}
              initial={{ opacity: 0, y: 18 }}
              whileInView={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.45, delay: index * 0.08 }}
              viewport={{ once: true }}
              className="rounded-2xl border border-border bg-card p-6 md:p-8 shadow-elevation-1 flex flex-col justify-between"
            >
              <div>
                <div className="flex items-center justify-between mb-6">
                  <span className="inline-flex items-center justify-center w-10 h-10 rounded-xl bg-zinc-900 text-white font-semibold text-sm">
                    {item.number ?? `0${item.step}`}
                  </span>
                  <span className="text-xs font-medium text-muted-foreground">
                    Step {item.step} of {HOW_IT_WORKS.length}
                  </span>
                </div>
                <h3 className="text-lg font-semibold text-foreground mb-2.5">
                  {item.title}
                </h3>
                <p className="text-sm text-muted-foreground leading-relaxed">
                  {item.description}
                </p>
              </div>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}
