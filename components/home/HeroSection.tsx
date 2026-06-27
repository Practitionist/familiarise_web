"use client";

import { useCallback, useState, useEffect } from "react";
import { ArrowRight, Play, Sparkles } from "lucide-react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { useInViewOnce } from "@/components/ui/reveal";
import { STATS } from "./data";

function AnimatedNumber({
  value,
  suffix = "",
}: {
  value: number;
  suffix: string;
}) {
  const [ref, isInView] = useInViewOnce<HTMLSpanElement>();
  const [displayValue, setDisplayValue] = useState(0);

  const animate = useCallback(() => {
    const duration = 2000;
    const steps = 60;
    const increment = value / steps;
    let current = 0;
    const timer = setInterval(() => {
      current += increment;
      if (current >= value) {
        setDisplayValue(value);
        clearInterval(timer);
      } else {
        setDisplayValue(Math.floor(current));
      }
    }, duration / steps);
    return () => clearInterval(timer);
  }, [value]);

  useEffect(() => {
    if (isInView) {
      return animate();
    }
  }, [isInView, animate]);

  return (
    <span
      ref={ref}
      className="text-4xl md:text-5xl font-bold text-white tabular-nums"
    >
      {value % 1 !== 0
        ? displayValue.toFixed(1)
        : displayValue.toLocaleString()}
      {suffix}
    </span>
  );
}

export function HeroSection() {
  return (
    <section className="relative min-h-[95vh] flex items-center bg-black overflow-hidden">
      {/* Animated gradient orbs */}
      <div className="absolute inset-0 overflow-hidden">
        <div className="absolute top-1/4 left-1/4 w-[600px] h-[600px] rounded-full bg-gradient-to-br from-zinc-800/50 to-transparent blur-[50px] animate-blob" />
        <div className="absolute top-1/3 right-1/4 w-[500px] h-[500px] rounded-full bg-gradient-to-bl from-zinc-700/30 to-transparent blur-[50px] animate-blob animation-delay-2000" />
        <div className="absolute bottom-1/4 left-1/2 w-[700px] h-[700px] rounded-full bg-gradient-to-t from-zinc-800/40 to-transparent blur-[50px] animate-blob animation-delay-4000" />
      </div>

      {/* Grid pattern overlay */}
      <div className="absolute inset-0 grid-pattern opacity-30" />

      {/* Spotlight effect */}
      <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[800px] h-[600px] bg-gradient-to-b from-zinc-800/20 via-transparent to-transparent blur-[40px]" />

      <div className="container mx-auto px-4 md:px-6 relative z-10 py-20 md:py-32">
        <div className="max-w-4xl mx-auto text-center">
          {/* Badge */}
          <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-white/5 backdrop-blur-sm border border-white/10 text-zinc-400 text-sm mb-8 animate-rise">
            <Sparkles className="w-4 h-4 text-zinc-300" />
            <span>Trusted by 10,000+ professionals worldwide</span>
          </div>

          {/* Main headline */}
          <h1
            className="text-fluid-5xl font-bold text-white mb-6 leading-tight tracking-tight animate-rise"
            style={{ animationDelay: "0.1s" }}
          >
            Learn from the{" "}
            <span className="relative inline-block">
              <span className="silver-text">best minds</span>
            </span>
            <br />
            <span className="text-zinc-400">in your industry</span>
          </h1>

          {/* Subheadline */}
          <p
            className="text-lg md:text-xl text-zinc-500 mb-10 max-w-2xl mx-auto leading-relaxed animate-rise"
            style={{ animationDelay: "0.2s" }}
          >
            Connect with world-class experts for personalized 1-on-1 sessions,
            interactive classes, and live webinars. Your career transformation
            starts here.
          </p>

          {/* CTAs */}
          <div
            className="flex flex-col sm:flex-row items-center justify-center gap-4 mb-16 animate-rise"
            style={{ animationDelay: "0.3s" }}
          >
            <Link href="/explore/experts">
              <Button
                size="lg"
                className="bg-white text-black hover:bg-zinc-200 px-8 h-14 text-base rounded-xl shadow-lg shadow-white/10 group font-medium"
              >
                Find Your Expert
                <ArrowRight className="ml-2 w-5 h-5 group-hover:translate-x-1 transition-transform" />
              </Button>
            </Link>
            <Button
              size="lg"
              variant="outline"
              className="border-zinc-700 bg-transparent text-white hover:bg-zinc-900 hover:text-white px-8 h-14 text-base rounded-xl group"
            >
              <Play className="mr-2 w-5 h-5" />
              Watch Demo
            </Button>
          </div>

          {/* Stats with animated counters */}
          <div
            className="grid grid-cols-2 md:grid-cols-4 gap-8 md:gap-12 pt-8 border-t border-zinc-800 animate-rise"
            style={{ animationDelay: "0.4s" }}
          >
            {STATS.map((stat, i) => (
              <div key={i} className="text-center">
                <AnimatedNumber value={stat.value} suffix={stat.suffix} />
                <div className="text-zinc-600 text-sm mt-1">{stat.label}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Bottom gradient fade */}
      <div className="absolute bottom-0 left-0 right-0 h-32 bg-gradient-to-t from-zinc-950 to-transparent" />
    </section>
  );
}
