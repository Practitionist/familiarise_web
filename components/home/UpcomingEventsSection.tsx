"use client";

import { ArrowRight, Calendar, Clock, Users } from "lucide-react";
import Link from "next/link";

import { RevealGroup, RevealItem, Reveal } from "@/components/motion";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { UPCOMING_EVENTS } from "./data";

/**
 * Upcoming events — static curated marketing data rendered on a dark strip
 * beneath the testimonials marquee. Self-contained: it no longer duplicates
 * the review cards that TestimonialsSection already owns.
 */
export function UpcomingEventsSection() {
  return (
    <section className="relative overflow-hidden bg-zinc-950 py-20 md:py-28">
      <div className="container mx-auto px-4 md:px-6">
        <div className="grid gap-12 lg:grid-cols-[1fr_1.4fr] lg:gap-20">
          {/* Editorial column */}
          <Reveal className="self-start lg:sticky lg:top-32">
            <Badge
              variant="secondary"
              className="mb-4 rounded-full border-zinc-800 bg-zinc-800/60 text-zinc-300 hover:bg-zinc-800"
            >
              Live sessions
            </Badge>
            <h2 className="text-fluid-3xl font-bold tracking-tight text-white text-balance">
              Something is always{" "}
              <span className="silver-text">happening</span>
            </h2>
            <p className="mt-4 max-w-sm leading-relaxed text-zinc-500">
              Workshops, webinars and cohort classes run every week — join one
              or bring your whole team.
            </p>
            <Link href="/explore/programs" className="inline-block mt-8">
              <Button
                variant="outline"
                className="group rounded-full border-zinc-800 text-zinc-200 hover:bg-zinc-900 hover:text-white hover:border-zinc-600"
              >
                Browse programs
                <ArrowRight className="ml-2 h-4 w-4 transition-transform duration-300 group-hover:translate-x-1" />
              </Button>
            </Link>
          </Reveal>

          {/* Events ledger */}
          <RevealGroup stagger={0.09} className="flex flex-col border-t border-white/[0.07]">
            {UPCOMING_EVENTS.map((event) => (
              <RevealItem key={event.title}>
                <Link
                  href="/explore/programs"
                  className="group flex flex-col gap-4 border-b border-white/[0.07] py-7 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:flex-row sm:items-center sm:gap-8"
                >
                  <div className="min-w-0 flex-1">
                    <span className="mb-2 inline-flex items-center rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-0.5 text-xs text-zinc-400">
                      {event.type}
                    </span>
                    <h4 className="text-lg font-semibold tracking-tight text-white transition-transform duration-500 ease-[cubic-bezier(0.16,1,0.3,1)] group-hover:translate-x-1.5">
                      {event.title}
                    </h4>
                    <p className="mt-1 text-sm text-zinc-500">
                      Hosted by {event.host}
                    </p>
                  </div>

                  <div className="flex shrink-0 items-center gap-5 text-sm text-zinc-500">
                    <span className="flex items-center gap-1.5">
                      <Calendar className="h-3.5 w-3.5" />
                      {event.date}
                    </span>
                    <span className="hidden items-center gap-1.5 md:flex">
                      <Clock className="h-3.5 w-3.5" />
                      {event.time}
                    </span>
                    <span className="flex items-center gap-1.5 tabular-nums">
                      <Users className="h-3.5 w-3.5" />
                      {event.attendees}
                    </span>
                    <ArrowRight className="h-4 w-4 -translate-x-1 opacity-0 transition-all duration-300 group-hover:translate-x-0 group-hover:opacity-100" />
                  </div>
                </Link>
              </RevealItem>
            ))}
          </RevealGroup>
        </div>
      </div>
    </section>
  );
}
