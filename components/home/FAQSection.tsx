"use client";

import { ArrowRight } from "lucide-react";
import Link from "next/link";

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { FAQ_ITEMS } from "./data";
import { Em, Eyebrow, Reveal, Section } from "./primitives";

export function FAQSection() {
  return (
    <Section id="faq">
      <div className="grid gap-12 lg:grid-cols-[1fr_1.6fr] lg:gap-20">
        <Reveal className="lg:sticky lg:top-[calc(var(--header-height)+2rem)] lg:self-start">
          <Eyebrow>FAQ</Eyebrow>
          <h2 className="font-serif text-4xl leading-[1.05] tracking-tight text-white md:text-5xl">
            Common <Em>questions</Em>
          </h2>
          <p className="mt-5 leading-relaxed text-zinc-400">
            Everything you need to know about getting started.
          </p>
          <Link
            href="/contactus"
            className="group mt-8 inline-flex items-center gap-1.5 text-sm text-zinc-300 transition-colors hover:text-white"
          >
            Still curious? Contact us
            <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
          </Link>
        </Reveal>

        <Reveal delay={0.08}>
          <Accordion
            type="single"
            collapsible
            className="border-t border-white/[0.08]"
          >
            {FAQ_ITEMS.map((item, index) => (
              <AccordionItem
                key={item.question}
                value={`item-${index}`}
                className="border-b border-white/[0.08]"
              >
                <AccordionTrigger className="py-6 text-left text-base font-medium text-white hover:no-underline [&>svg]:text-zinc-500">
                  {item.question}
                </AccordionTrigger>
                <AccordionContent className="pb-6 pr-8 text-[15px] leading-relaxed text-zinc-400">
                  {item.answer}
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        </Reveal>
      </div>
    </Section>
  );
}
