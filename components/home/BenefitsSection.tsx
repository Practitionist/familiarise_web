"use client";

import { motion } from "framer-motion";
import { ArrowUpRight } from "lucide-react";
import Link from "next/link";

import { RevealGroup, RevealItem, Reveal } from "@/components/motion";
import { Badge } from "@/components/ui/badge";
import { renderLCPImage } from "@/utils/image";
import type { SupabaseImageFile } from "@/lib/supabase";
import { BENEFITS } from "./data";

interface BenefitsSectionProps {
  images: SupabaseImageFile[];
}

export function BenefitsSection({ images }: BenefitsSectionProps) {
  return (
    <section className="bg-background py-20 md:py-32 relative overflow-hidden">
      <div className="container mx-auto px-4 md:px-6">
        <div className="grid gap-14 lg:grid-cols-2 lg:gap-20">
          {/* Sticky editorial column */}
          <div className="lg:sticky lg:top-32 self-start">
            <Reveal>
              <Badge variant="secondary" className="mb-4 rounded-full border-0">
                Why Familiarise
              </Badge>
              <h2 className="text-fluid-4xl font-bold tracking-tight text-foreground text-balance">
                Years of insight,{" "}
                <span className="gradient-text-dark">compressed into hours</span>
              </h2>
              <p className="mt-5 max-w-md leading-relaxed text-muted-foreground">
                Join thousands of professionals accelerating their careers
                through personalised mentorship and expert guidance.
              </p>
              <Link
                href="/explore/experts"
                className="group mt-8 inline-flex items-center gap-1.5 text-sm font-medium text-foreground"
              >
                <span className="link-sweep pb-0.5">Start learning today</span>
                <ArrowUpRight className="h-4 w-4 transition-transform duration-300 group-hover:-translate-y-0.5 group-hover:translate-x-0.5" />
              </Link>
            </Reveal>

            {/* Session imagery */}
            <Reveal delay={0.15} className="relative mt-12 hidden lg:block">
              <div className="overflow-hidden rounded-2xl border border-border shadow-card">
                {renderLCPImage(images, 0, "/placeholder.svg", 600, 400)}
              </div>
            </Reveal>
          </div>

          {/* Benefits ledger */}
          <RevealGroup stagger={0.1} className="flex flex-col divide-y divide-border/70 border-y border-border/70">
            {BENEFITS.map((benefit, index) => (
              <RevealItem key={benefit.title}>
                <div className="group flex items-start gap-6 py-9 transition-colors">
                  <span className="pt-1 font-mono text-xs text-muted-foreground/60">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <div className="transition-transform duration-500 ease-[cubic-bezier(0.16,1,0.3,1)] group-hover:translate-x-1.5">
                    <h4 className="text-xl font-semibold tracking-tight text-foreground flex items-center gap-3">
                      <benefit.icon className="h-5 w-5 text-muted-foreground" />
                      {benefit.title}
                    </h4>
                    <p className="mt-2 max-w-lg leading-relaxed text-muted-foreground">
                      {benefit.description}
                    </p>
                  </div>
                </div>
              </RevealItem>
            ))}
          </RevealGroup>
        </div>
      </div>

      {/* Soft ambient wash */}
      <motion.div
        aria-hidden
        initial={{ opacity: 0 }}
        whileInView={{ opacity: 1 }}
        viewport={{ once: true }}
        transition={{ duration: 1.2 }}
        className="pointer-events-none absolute -right-40 top-1/3 h-[420px] w-[420px] rounded-full bg-zinc-200/40 blur-[120px]"
      />
    </section>
  );
}
