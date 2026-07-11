"use client";

import { useState } from "react";
import Image from "next/image";
import { motion } from "framer-motion";
import { Star } from "lucide-react";

import { lookupCompanyDomain } from "@/lib/data/known-companies";
import { AnimatedNumber } from "./AnimatedNumber";
import { COMPANY_LOGOS, STATS } from "./data";

const LOGO_DEV_TOKEN = process.env.NEXT_PUBLIC_LOGO_DEV_TOKEN;

// Degrades to a text wordmark when Logo.dev is unavailable so the strip never breaks.
function MarqueeLogo({ name }: { name: string }) {
  const [imgError, setImgError] = useState(false);
  const domain = lookupCompanyDomain(name);

  if (!domain || !LOGO_DEV_TOKEN || imgError) {
    return (
      <span className="text-zinc-600 font-semibold text-lg md:text-xl whitespace-nowrap">
        {name}
      </span>
    );
  }

  return (
    <Image
      src={`https://img.logo.dev/${domain}?token=${LOGO_DEV_TOKEN}&size=96&format=png`}
      alt={`${name} logo`}
      width={96}
      height={36}
      className="h-8 md:h-9 w-auto object-contain grayscale brightness-0 invert opacity-40 transition-all duration-300 hover:grayscale-0 hover:brightness-100 hover:invert-0 hover:opacity-100"
      onError={() => setImgError(true)}
    />
  );
}

export function LogoMarqueeSection() {
  return (
    <section className="py-14 bg-zinc-950 border-b border-zinc-900 overflow-hidden">
      <div className="container mx-auto px-4 md:px-6">
        <motion.p
          initial={{ opacity: 0 }}
          whileInView={{ opacity: 1 }}
          transition={{ duration: 0.5 }}
          viewport={{ once: true }}
          className="text-center text-zinc-500 text-sm mb-10"
        >
          Our experts have worked at the world&apos;s best companies
        </motion.p>
      </div>

      <div className="relative">
        <div className="absolute left-0 top-0 bottom-0 w-24 md:w-40 bg-gradient-to-r from-zinc-950 to-transparent z-10" />
        <div className="absolute right-0 top-0 bottom-0 w-24 md:w-40 bg-gradient-to-l from-zinc-950 to-transparent z-10" />

        <div className="flex w-max items-center gap-14 md:gap-20 animate-marquee-slow hover:[animation-play-state:paused]">
          {[...COMPANY_LOGOS, ...COMPANY_LOGOS].map((company, i) => (
            <div
              key={`${company}-${i}`}
              className="flex items-center justify-center h-10 shrink-0"
            >
              <MarqueeLogo name={company} />
            </div>
          ))}
        </div>
      </div>

      {/* Proof strip — hero stats live here to keep the hero minimal */}
      <div className="container mx-auto px-4 md:px-6">
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          whileInView={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
          viewport={{ once: true }}
          className="mt-12 pt-10 border-t border-zinc-900 grid grid-cols-2 md:grid-cols-4 gap-8"
        >
          {STATS.map((stat) => (
            <div key={stat.label} className="text-center">
              <div className="flex items-center justify-center gap-1.5">
                <AnimatedNumber
                  value={stat.value}
                  suffix={stat.suffix}
                  className="text-2xl md:text-3xl font-bold text-white tabular-nums"
                />
                {stat.label === "Average Rating" && (
                  <Star className="w-5 h-5 fill-amber-400 text-amber-400" />
                )}
              </div>
              <div className="text-zinc-600 text-sm mt-1">{stat.label}</div>
            </div>
          ))}
        </motion.div>
      </div>
    </section>
  );
}
