"use client";

import { motion } from "framer-motion";
import { ArrowRight, Building2 } from "lucide-react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { ENTERPRISE_FEATURES } from "./data";

/**
 * Path for buyers arriving on behalf of an organisation — sponsored bookings,
 * procurement invoicing, and hosted expert networks.
 */
export function EnterpriseSection() {
  return (
    <section className="py-20 md:py-28 bg-muted border-b border-border">
      <div className="max-w-[1400px] mx-auto px-4 sm:px-8 xl:px-12">
        <div className="flex flex-col lg:flex-row lg:items-end lg:justify-between gap-6 mb-14">
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            whileInView={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.45 }}
            viewport={{ once: true }}
            className="max-w-2xl"
          >
            <div className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-widest text-muted-foreground mb-3">
              <Building2 className="w-3.5 h-3.5" />
              <span>For Teams &amp; Organisations</span>
            </div>
            <h2 className="text-fluid-3xl md:text-fluid-4xl font-bold tracking-tight text-foreground mb-3">
              Bring Familiarise to your whole team
            </h2>
            <p className="text-base md:text-lg text-muted-foreground leading-relaxed">
              Sponsor sessions for your people, run structured mentorship
              programs, or host your own expert network — with the billing and
              compliance your finance team expects.
            </p>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, y: 12 }}
            whileInView={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.45, delay: 0.05 }}
            viewport={{ once: true }}
            className="flex flex-wrap gap-3 shrink-0"
          >
            <Button
              size="lg"
              className="h-11 px-6 rounded-xl bg-primary text-primary-foreground hover:bg-primary/90"
              asChild
            >
              <Link href="/enterprise">
                Explore Enterprise
                <ArrowRight className="w-4 h-4 ml-2" />
              </Link>
            </Button>
            <Button
              size="lg"
              variant="outline"
              className="h-11 px-6 rounded-xl border-border bg-card hover:bg-muted"
              asChild
            >
              <Link href="/explore/enterprise/organisations">
                Browse Organisations
              </Link>
            </Button>
          </motion.div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          {ENTERPRISE_FEATURES.map((feature, index) => {
            const Icon = feature.icon;
            return (
              <motion.div
                key={feature.title}
                initial={{ opacity: 0, y: 16 }}
                whileInView={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.4, delay: index * 0.06 }}
                viewport={{ once: true }}
                className="flex gap-4 p-6 rounded-2xl bg-card border border-border shadow-elevation-1"
              >
                <div className="w-11 h-11 rounded-xl bg-zinc-900 text-white flex items-center justify-center shrink-0">
                  <Icon className="w-5 h-5" />
                </div>
                <div className="min-w-0">
                  <h3 className="font-semibold text-foreground mb-1.5">
                    {feature.title}
                  </h3>
                  <p className="text-sm text-muted-foreground leading-relaxed">
                    {feature.description}
                  </p>
                </div>
              </motion.div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
