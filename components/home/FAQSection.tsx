"use client";

import { motion } from "framer-motion";
import Link from "next/link";

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { FAQ_ITEMS } from "./data";

export function FAQSection() {
  return (
    <section className="py-20 md:py-28 bg-background border-b border-border">
      <div className="max-w-3xl mx-auto px-4 sm:px-6">
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.45 }}
          viewport={{ once: true }}
          className="text-center mb-12"
        >
          <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground mb-3">
            Frequently Asked Questions
          </p>
          <h2 className="text-fluid-3xl md:text-fluid-4xl font-bold text-foreground mb-3 tracking-tight">
            Everything you need to know
          </h2>
          <p className="text-base text-muted-foreground">
            Clear answers on booking, escrow protection, rescheduling, and
            joining as an expert.
          </p>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.45, delay: 0.08 }}
          viewport={{ once: true }}
          className="rounded-2xl border border-border bg-card px-6 shadow-elevation-1"
        >
          <Accordion type="single" collapsible className="w-full">
            {FAQ_ITEMS.map((item, index) => (
              <AccordionItem
                key={index}
                value={`item-${index}`}
                className="last:border-b-0"
              >
                <AccordionTrigger className="text-left hover:no-underline py-5">
                  <span className="font-semibold text-foreground text-base">
                    {item.question}
                  </span>
                </AccordionTrigger>
                <AccordionContent className="text-muted-foreground pb-5 leading-relaxed text-sm">
                  {item.answer}
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        </motion.div>

        <p className="text-center text-sm text-muted-foreground mt-8">
          Still have questions? Visit our{" "}
          <Link
            href="/support"
            className="font-medium text-foreground underline underline-offset-4 hover:text-foreground/80"
          >
            Help Center
          </Link>{" "}
          or{" "}
          <Link
            href="/contactus"
            className="font-medium text-foreground underline underline-offset-4 hover:text-foreground/80"
          >
            contact our team
          </Link>
          .
        </p>
      </div>
    </section>
  );
}
