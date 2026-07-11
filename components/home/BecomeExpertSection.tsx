"use client";

import { motion } from "framer-motion";
import { ArrowRight, Clock, Mic, Target } from "lucide-react";
import Image from "next/image";
import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import becomeExpertPhoto from "@/public/images/landing/become-expert.jpg";

const EXPERT_BENEFITS = [
  { icon: Target, label: "Set Your Rates" },
  { icon: Clock, label: "Flexible Schedule" },
  { icon: Mic, label: "Build Your Brand" },
];

export function BecomeExpertSection() {
  return (
    <section className="py-24 md:py-32 bg-zinc-950 relative overflow-hidden">
      <div className="absolute inset-0">
        <div className="absolute top-1/4 right-1/4 w-[400px] h-[400px] bg-zinc-800/40 rounded-full blur-[100px] animate-blob" />
        <div className="absolute bottom-1/4 left-1/4 w-[500px] h-[500px] bg-zinc-800/30 rounded-full blur-[100px] animate-blob animation-delay-2000" />
      </div>
      <div className="absolute inset-0 grid-pattern opacity-20" />

      <div className="container mx-auto px-4 md:px-6 relative z-10">
        <div className="grid lg:grid-cols-2 gap-16 items-center">
          <motion.div
            initial={{ opacity: 0, x: -30 }}
            whileInView={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.6 }}
            viewport={{ once: true }}
          >
            <Badge
              variant="secondary"
              className="mb-4 bg-zinc-800 text-zinc-300 hover:bg-zinc-800 border-zinc-700"
            >
              Share Your Expertise
            </Badge>
            <h2 className="text-fluid-4xl font-bold text-white mb-6 tracking-tight">
              Become an expert on{" "}
              <span className="silver-text">Familiarise</span>
            </h2>
            <p className="text-lg text-zinc-400 mb-8 max-w-xl">
              Join our network of professionals. Share your knowledge, build
              your personal brand, and earn while helping others grow.
            </p>

            <div className="flex flex-wrap gap-x-8 gap-y-4 mb-10">
              {EXPERT_BENEFITS.map((item, i) => (
                <motion.div
                  key={item.label}
                  initial={{ opacity: 0, y: 20 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.4, delay: i * 0.1 }}
                  viewport={{ once: true }}
                  className="flex items-center gap-2 text-zinc-200"
                >
                  <item.icon className="w-5 h-5 text-zinc-400" />
                  <span className="font-medium">{item.label}</span>
                </motion.div>
              ))}
            </div>

            <div className="flex flex-col sm:flex-row items-start gap-4">
              <Link href="/form/onboarding">
                <Button
                  size="lg"
                  className="bg-white text-black hover:bg-zinc-200 px-8 h-14 text-base rounded-xl shadow-lg shadow-white/10"
                >
                  Apply as Expert
                  <ArrowRight className="ml-2 w-5 h-5" />
                </Button>
              </Link>
              <Link href="/contactus">
                <Button
                  size="lg"
                  variant="outline"
                  className="px-8 h-14 text-base rounded-xl border-zinc-700 bg-transparent text-white hover:bg-zinc-900 hover:text-white"
                >
                  Learn More
                </Button>
              </Link>
            </div>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, x: 30 }}
            whileInView={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.6 }}
            viewport={{ once: true }}
            className="relative hidden lg:block"
          >
            <div className="rounded-3xl overflow-hidden border border-zinc-800 shadow-elevation-3 duotone max-w-md ml-auto">
              <Image
                src={becomeExpertPhoto}
                alt="Expert sharing knowledge in a teaching session"
                className="w-full h-auto object-cover"
                sizes="(min-width: 1024px) 40vw, 0px"
                placeholder="blur"
              />
            </div>
          </motion.div>
        </div>
      </div>
    </section>
  );
}
