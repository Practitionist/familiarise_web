"use client";

import { cn } from "@/utils/tailwind";
import { COMPANY_LOGOS } from "./data";
import { Reveal, container } from "./primitives";

export function TrustedBySection() {
  return (
    <section className="border-t border-white/[0.06] py-14">
      <div className={cn(container)}>
        <Reveal className="flex flex-col items-center gap-8 lg:flex-row lg:gap-16">
          <p className="shrink-0 text-center text-sm text-zinc-400 lg:max-w-[14rem] lg:text-left">
            Our experts have worked at leading companies
          </p>
          <ul className="grid w-full grid-cols-2 gap-x-8 gap-y-6 sm:grid-cols-4 lg:grid-cols-8">
            {COMPANY_LOGOS.map((company) => (
              <li
                key={company}
                className="text-center text-lg font-semibold tracking-tight text-zinc-500 transition-colors hover:text-zinc-200"
              >
                {company}
              </li>
            ))}
          </ul>
        </Reveal>
      </div>
    </section>
  );
}
