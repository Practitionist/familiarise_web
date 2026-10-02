"use client";

import { motion } from "framer-motion";
import { ArrowRight, LucideIcon } from "lucide-react";
import Link from "next/link";

import { FEATURES, PLATFORM_FEATURES } from "./data";

function FeatureCard({
  feature,
  index,
}: {
  feature: {
    icon: LucideIcon;
    title: string;
    badge?: string;
    meta?: string;
    description: string;
    href?: string;
    cta?: string;
  };
  index: number;
}) {
  const Icon = feature.icon;
  const href = feature.href ?? "/explore/experts";

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      whileInView={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.45, delay: index * 0.06 }}
      viewport={{ once: true }}
    >
      <Link
        href={href}
        className="group flex flex-col justify-between h-full rounded-2xl border border-white/[0.08] bg-zinc-900/60 p-6 md:p-7 hover:border-white/20 hover:bg-zinc-900 transition-all duration-200"
      >
        <div>
          <div className="flex items-center justify-between gap-3 mb-5">
            <div className="w-12 h-12 rounded-xl bg-white/[0.06] border border-white/10 flex items-center justify-center text-white">
              <Icon className="w-5 h-5" />
            </div>
            {feature.badge && (
              <span className="text-xs font-medium px-2.5 py-1 rounded-full bg-white/[0.06] border border-white/10 text-zinc-300">
                {feature.badge}
              </span>
            )}
          </div>
          <h3 className="text-lg font-semibold text-white mb-1.5">
            {feature.title}
          </h3>
          {feature.meta && (
            <p className="text-xs font-medium text-zinc-400 mb-3">
              {feature.meta}
            </p>
          )}
          <p className="text-sm text-zinc-400 leading-relaxed mb-6">
            {feature.description}
          </p>
        </div>

        <div className="inline-flex items-center text-sm font-medium text-white group-hover:text-zinc-200 pt-4 border-t border-white/[0.06]">
          <span>{feature.cta ?? "Explore"}</span>
          <ArrowRight className="ml-1.5 w-4 h-4 group-hover:translate-x-1 transition-transform" />
        </div>
      </Link>
    </motion.div>
  );
}

export function FeaturesSection() {
  const coreCapabilities = PLATFORM_FEATURES.slice(0, 6);

  return (
    <section className="py-20 md:py-28 bg-zinc-950 text-white relative overflow-hidden">
      <div className="pointer-events-none absolute inset-0 grid-pattern opacity-20" />

      <div className="max-w-[1400px] mx-auto px-4 sm:px-8 xl:px-12 relative z-10">
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.45 }}
          viewport={{ once: true }}
          className="max-w-2xl mb-14"
        >
          <p className="text-xs font-semibold uppercase tracking-widest text-zinc-400 mb-3">
            Session Formats &amp; Platform
          </p>
          <h2 className="text-fluid-3xl md:text-fluid-4xl font-bold text-white mb-4 tracking-tight">
            Four ways to learn,{" "}
            <span className="text-zinc-400">one integrated workspace</span>
          </h2>
          <p className="text-base md:text-lg text-zinc-400 leading-relaxed">
            Whether you need a single 45-minute architecture review or a
            multi-month mentorship plan, every format runs end-to-end inside
            Familiarise.
          </p>
        </motion.div>

        {/* 4 Core Session Formats */}
        <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-5 mb-16">
          {FEATURES.map((feature, index) => (
            <FeatureCard key={feature.title} feature={feature} index={index} />
          ))}
        </div>

        {/* Integrated Platform Capabilities Strip */}
        <div className="pt-12 border-t border-white/[0.08]">
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 mb-8">
            <div>
              <h3 className="text-lg font-semibold text-white">
                Built-in tools for every session
              </h3>
              <p className="text-sm text-zinc-400">
                No third-party links, manual calendar invites, or unverified
                payment transfers.
              </p>
            </div>
            <Link
              href="/pricing"
              className="inline-flex items-center text-sm font-medium text-zinc-300 hover:text-white transition-colors"
            >
              See how pricing &amp; escrow protection work
              <ArrowRight className="ml-1.5 w-4 h-4" />
            </Link>
          </div>

          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {coreCapabilities.map((item, idx) => {
              const Icon = item.icon;
              return (
                <motion.div
                  key={item.title}
                  initial={{ opacity: 0, y: 14 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.4, delay: idx * 0.04 }}
                  viewport={{ once: true }}
                  className="flex items-start gap-3.5 rounded-xl border border-white/[0.08] bg-zinc-900/40 p-4"
                >
                  <div className="w-9 h-9 rounded-lg bg-white/[0.06] border border-white/10 flex items-center justify-center shrink-0 mt-0.5">
                    <Icon className="w-4 h-4 text-zinc-300" />
                  </div>
                  <div className="min-w-0">
                    <h4 className="text-sm font-semibold text-white mb-1">
                      {item.title}
                    </h4>
                    <p className="text-xs text-zinc-400 leading-relaxed">
                      {item.description}
                    </p>
                  </div>
                </motion.div>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}
