"use client";

import { motion } from "framer-motion";
import { COMPANY_LOGOS } from "./data";

export function TrustedBySection() {
  return (
    <section className="py-12 bg-zinc-950 border-y border-white/[0.08]">
      <div className="max-w-[1400px] mx-auto px-4 sm:px-8 xl:px-12">
        <motion.p
          initial={{ opacity: 0 }}
          whileInView={{ opacity: 1 }}
          transition={{ duration: 0.4 }}
          viewport={{ once: true }}
          className="text-center text-xs font-semibold uppercase tracking-widest text-zinc-500 mb-7"
        >
          Our verified experts bring experience from leading organisations
        </motion.p>
        <div className="flex flex-wrap items-center justify-center gap-x-10 gap-y-4 md:gap-x-16">
          {COMPANY_LOGOS.map((company, i) => (
            <motion.span
              key={company}
              initial={{ opacity: 0, y: 8 }}
              whileInView={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.35, delay: i * 0.04 }}
              viewport={{ once: true }}
              className="text-zinc-400/80 font-semibold text-base md:text-lg tracking-tight hover:text-white transition-colors select-none"
            >
              {company}
            </motion.span>
          ))}
        </div>
      </div>
    </section>
  );
}
