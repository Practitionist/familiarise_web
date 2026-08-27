"use client";

import { motion } from "framer-motion";
import { ArrowRight, Building2, Mic } from "lucide-react";
import Link from "next/link";

import { Reveal } from "@/components/motion";

const PATHS = [
  {
    icon: Mic,
    eyebrow: "For experts",
    title: "Teach what you know",
    description:
      "Set your rates, choose your schedule, and build your brand on a platform that handles payments, scheduling and delivery for you.",
    cta: "Apply as an expert",
    href: "/become-an-expert",
    links: [
      { label: "Expert networks", href: "/explore/enterprise/organisations" },
    ],
  },
  {
    icon: Building2,
    eyebrow: "For teams",
    title: "Upskill your organisation",
    description:
      "One plan covering every seat, sponsored sessions with budgets, GST-compliant invoicing — or run your own expert network.",
    cta: "Explore for enterprise",
    href: "/enterprise",
    links: [{ label: "Browse organisations", href: "/explore/enterprise/organisations" }],
  },
];

/**
 * Closing CTA — a split stage where the hovered panel brightens while its
 * sibling dims. Replaces the separate BecomeExpert/Enterprise sections so the
 * page ends with one decisive "which side are you on?" choice.
 */
export function CTAFinaleSection() {
  return (
    <section className="bg-background py-20 md:py-28">
      <div className="container mx-auto px-4 md:px-6">
        <Reveal>
          <h2 className="sr-only">Join Familiarise</h2>
          <div className="grid overflow-hidden rounded-3xl border border-border shadow-card lg:grid-cols-2">
            {PATHS.map((path, i) => (
              <motion.div
                key={path.eyebrow}
                initial={{ opacity: 0, y: 24 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{
                  duration: 0.7,
                  delay: i * 0.12,
                  ease: [0.16, 1, 0.3, 1],
                }}
                className={`group relative flex flex-col justify-between gap-10 p-8 md:p-12 ${
                  i === 0
                    ? "bg-zinc-950 text-white"
                    : "border-t border-border bg-smoke text-foreground lg:border-l lg:border-t-0"
                }`}
              >
                {/* Hover glow */}
                <div
                  aria-hidden
                  className="pointer-events-none absolute -inset-x-10 -top-24 h-56 opacity-0 transition-opacity duration-700 group-hover:opacity-100"
                  style={{
                    background:
                      "radial-gradient(400px circle at 50% 0%, rgba(255,255,255,0.08), transparent 70%)",
                  }}
                />
                <div className="relative z-10">
                  <span
                    className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium tracking-wide uppercase ${
                      i === 0
                        ? "border-white/15 bg-white/[0.05] text-zinc-300"
                        : "border-border bg-secondary text-muted-foreground"
                    }`}
                  >
                    <path.icon className="h-3.5 w-3.5" />
                    {path.eyebrow}
                  </span>
                  <h3 className="mt-6 text-fluid-3xl font-bold tracking-tight text-balance">
                    {path.title}
                  </h3>
                  <p
                    className={`mt-4 max-w-md leading-relaxed ${
                      i === 0 ? "text-zinc-400" : "text-muted-foreground"
                    }`}
                  >
                    {path.description}
                  </p>
                </div>

                <div className="relative z-10 flex flex-wrap items-center gap-5">
                  <Link
                    href={path.href}
                    className={`sheen group/btn inline-flex h-12 items-center gap-2 rounded-full px-7 text-sm font-medium transition-transform duration-300 hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                      i === 0
                        ? "sheen bg-white text-black hover:bg-zinc-200"
                        : "bg-primary text-primary-foreground hover:bg-primary/90"
                    }`}
                  >
                    {path.cta}
                    <ArrowRight className="h-4 w-4 transition-transform duration-300 group-hover/btn:translate-x-1" />
                  </Link>
                  {path.links.map((link) => (
                    <Link
                      key={link.label}
                      href={link.href}
                      className={`text-sm link-sweep pb-0.5 ${
                        i === 0 ? "text-zinc-400" : "text-muted-foreground"
                      }`}
                    >
                      {link.label}
                    </Link>
                  ))}
                </div>
              </motion.div>
            ))}
          </div>
        </Reveal>
      </div>
    </section>
  );
}
