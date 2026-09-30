"use client";

import { FEATURES, PLATFORM_FEATURES } from "./data";
import {
  Em,
  Reveal,
  Section,
  SectionHeading,
  surface,
  surfaceInteractive,
} from "./primitives";
import { cn } from "@/utils/tailwind";

/**
 * What you can buy (the four formats) and what every format comes with (the
 * platform). Replaces the separate "Our Offerings" and 12-item "Platform
 * Features" sections.
 */
export function OfferingsSection() {
  return (
    <Section id="offerings">
      <SectionHeading
        eyebrow="Offerings"
        title={
          <>
            Four ways to learn, <Em>one place to grow</Em>
          </>
        }
        description="Pick the format that fits the problem — a single focused call, a few months of mentorship, or a live room full of peers."
      />

      <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {FEATURES.map((feature, i) => {
          const Icon = feature.icon;
          return (
            <Reveal
              as="li"
              key={feature.title}
              delay={i * 0.05}
              className={cn(surface, surfaceInteractive, "flex flex-col p-6")}
            >
              <div className="mb-10 flex h-10 w-10 items-center justify-center rounded-xl border border-white/10 bg-white/[0.04]">
                <Icon className="h-5 w-5 text-zinc-200" />
              </div>
              <p className="text-xs uppercase tracking-[0.16em] text-zinc-500">
                {feature.meta}
              </p>
              <h3 className="mt-2 text-lg font-medium text-white">
                {feature.title}
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-zinc-400">
                {feature.description}
              </p>
            </Reveal>
          );
        })}
      </ul>

      {/* Platform: a hairline grid rather than 12 more cards. */}
      <Reveal className="mt-20">
        <h3 className="mb-8 text-sm font-medium text-zinc-400">
          Every format includes
        </h3>
        <ul className="grid overflow-hidden rounded-2xl border border-white/[0.08] sm:grid-cols-2 lg:grid-cols-3">
          {PLATFORM_FEATURES.map((feature) => {
            const Icon = feature.icon;
            return (
              <li
                key={feature.title}
                className="-mb-px -mr-px flex gap-4 border-b border-r border-white/[0.08] p-6"
              >
                <Icon className="mt-0.5 h-5 w-5 shrink-0 text-zinc-300" />
                <div>
                  <p className="font-medium text-white">{feature.title}</p>
                  <p className="mt-1 text-sm leading-relaxed text-zinc-400">
                    {feature.description}
                  </p>
                </div>
              </li>
            );
          })}
        </ul>
      </Reveal>
    </Section>
  );
}
