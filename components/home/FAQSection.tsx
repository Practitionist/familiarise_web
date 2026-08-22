"use client";

import { motion } from "framer-motion";
import Link from "next/link";

import { Reveal } from "@/components/motion";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { FAQ_ITEMS } from "./data";

export function FAQSection() {
  return (
    <section className="bg-smoke py-20 md:py-32">
      <div className="container mx-auto px-4 md:px-6">
        <div className="grid gap-12 lg:grid-cols-[1fr_1.6fr] lg:gap-20">
          {/* Editorial column */}
          <Reveal className="self-start lg:sticky lg:top-32">
            <h2 className="text-fluid-4xl font-bold tracking-tight text-foreground text-balance">
              Common <span className="text-muted-foreground">questions</span>
            </h2>
            <p className="mt-4 max-w-sm leading-relaxed text-muted-foreground">
              Everything you need to know about getting started. Still unsure?{" "}
              <Link href="/contactus" className="link-sweep text-foreground pb-0.5 font-medium">
                Talk to us
              </Link>
              .
            </p>
          </Reveal>

          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.1, ease: [0.16, 1, 0.3, 1] }}
            viewport={{ once: true }}
          >
            <Accordion
              type="single"
              collapsible
              defaultValue="item-0"
              className="border-t border-border"
            >
              {FAQ_ITEMS.map((item, index) => (
                <AccordionItem
                  key={index}
                  value={`item-${index}`}
                  className="border-b border-border"
                >
                  <AccordionTrigger className="py-6 text-left hover:no-underline group">
                    <span className="flex items-baseline gap-5">
                      <span className="font-mono text-xs text-muted-foreground/60">
                        {String(index + 1).padStart(2, "0")}
                      </span>
                      <span className="font-medium tracking-tight text-foreground transition-transform duration-500 ease-[cubic-bezier(0.16,1,0.3,1)] group-hover:translate-x-1">
                        {item.question}
                      </span>
                    </span>
                  </AccordionTrigger>
                  <AccordionContent className="pb-6 pl-9 leading-relaxed text-muted-foreground">
                    {item.answer}
                  </AccordionContent>
                </AccordionItem>
              ))}
            </Accordion>
          </motion.div>
        </div>
      </div>
    </section>
  );
}
