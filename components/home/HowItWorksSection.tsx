"use client";

import { HOW_IT_WORKS } from "./data";
import { Em, Reveal, Section, SectionHeading } from "./primitives";

export function HowItWorksSection() {
  return (
    <Section id="how-it-works">
      <SectionHeading
        eyebrow="How it works"
        title={
          <>
            From question to <Em>clarity</Em> in four steps
          </>
        }
      />

      <ol className="grid gap-10 sm:grid-cols-2 lg:grid-cols-4 lg:gap-8">
        {HOW_IT_WORKS.map((step, i) => (
          <Reveal as="li" key={step.step} delay={i * 0.06} className="relative">
            <div className="flex items-center gap-4">
              <span className="font-serif text-5xl italic leading-none text-white">
                {String(step.step).padStart(2, "0")}
              </span>
              {/* Connector to the next step on wide screens */}
              {i < HOW_IT_WORKS.length - 1 && (
                <span
                  aria-hidden
                  className="hidden h-px flex-1 bg-gradient-to-r from-white/20 to-transparent lg:block"
                />
              )}
            </div>
            <h3 className="mt-6 text-lg font-medium text-white">{step.title}</h3>
            <p className="mt-2 text-sm leading-relaxed text-zinc-400">
              {step.description}
            </p>
          </Reveal>
        ))}
      </ol>
    </Section>
  );
}
