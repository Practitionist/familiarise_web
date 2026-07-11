"use client";

import { motion } from "framer-motion";
import { LucideIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { FEATURES, PLATFORM_HIGHLIGHTS } from "./data";

// Asymmetric col spans give the bento rhythm: 7/5 then 5/7, then four small tiles.
const LARGE_SPANS = [
  "md:col-span-7",
  "md:col-span-5",
  "md:col-span-5",
  "md:col-span-7",
];

function LargeFeatureCard({
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
    <motion.div
      initial={{ opacity: 0, y: 24 }}
      whileInView={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, delay: index * 0.08 }}
      viewport={{ once: true }}
      className={`col-span-1 ${LARGE_SPANS[index % LARGE_SPANS.length]}`}
    >
      <div className="group h-full rounded-3xl border border-border bg-card p-8 md:p-10 shadow-elevation-1 hover:shadow-elevation-2 hover:border-zinc-300 transition-all duration-300 relative overflow-hidden">
        <div className="absolute inset-0 dot-pattern-light opacity-0 group-hover:opacity-40 transition-opacity duration-500" />
        <div className="relative z-10">
          <div
            className={`w-14 h-14 rounded-2xl bg-gradient-to-br ${feature.gradient} flex items-center justify-center mb-6 shadow-lg`}
          >
            <Icon className="w-7 h-7 text-white" />
          </div>
          <h3 className="text-xl md:text-2xl font-semibold mb-3 text-foreground tracking-tight">
            {feature.title}
          </h3>
          <p className="text-muted-foreground leading-relaxed max-w-md">
            {feature.description}
          </p>
        </div>
      </div>
    </motion.div>
  );
}

function HighlightTile({
  highlight,
  index,
}: {
  highlight: { icon: LucideIcon; title: string; description: string };
  index: number;
}) {
  const Icon = highlight.icon;

  return (
    <motion.div
      initial={{ opacity: 0, y: 24 }}
      whileInView={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, delay: 0.2 + index * 0.06 }}
      viewport={{ once: true }}
      className="col-span-1 md:col-span-3"
    >
      <div className="h-full rounded-3xl border border-border bg-card p-6 shadow-elevation-1 hover:shadow-elevation-2 hover:border-zinc-300 transition-all duration-300">
        <div className="w-10 h-10 rounded-xl bg-muted flex items-center justify-center mb-4">
          <Icon className="w-5 h-5 text-foreground" />
        </div>
        <h4 className="font-semibold text-foreground mb-1.5 tracking-tight">
          {highlight.title}
        </h4>
        <p className="text-sm text-muted-foreground leading-relaxed">
          {highlight.description}
        </p>
      </div>
    </motion.div>
  );
}

export function FeaturesSection() {
  return (
    <section className="py-24 md:py-32 bg-gradient-to-b from-white to-zinc-50 relative overflow-hidden">
      <div className="container mx-auto px-4 md:px-6 relative z-10">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
          viewport={{ once: true }}
          className="text-center mb-16"
        >
          <Badge
            variant="secondary"
            className="mb-4 bg-secondary text-secondary-foreground hover:bg-secondary border-0"
          >
            Our Offerings
          </Badge>
          <h2 className="text-fluid-4xl font-bold text-foreground mb-4 tracking-tight">
            Multiple ways to{" "}
            <span className="text-muted-foreground">learn & grow</span>
          </h2>
          <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
            Choose the format that works best for your learning style and
            schedule
          </p>
        </motion.div>

        <div className="grid grid-cols-1 md:grid-cols-12 gap-4 md:gap-5">
          {FEATURES.map((feature, index) => (
            <LargeFeatureCard
              key={feature.title}
              feature={feature}
              index={index}
            />
          ))}
          {PLATFORM_HIGHLIGHTS.map((highlight, index) => (
            <HighlightTile
              key={highlight.title}
              highlight={highlight}
              index={index}
            />
          ))}
        </div>
      </div>
    </section>
  );
}
