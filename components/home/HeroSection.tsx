import { ArrowRight, Sparkles } from "lucide-react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import type { ExpertStatKey, IPublicStat } from "@/lib/data/public-stats";

function AnimatedNumber({
  value,
  suffix = "",
}: {
  value: number;
  suffix?: string;
}) {
  return (
    <span className="text-4xl md:text-5xl font-bold text-white tabular-nums">
      {value % 1 !== 0 ? value.toFixed(1) : value.toLocaleString()}
      {suffix}
    </span>
  );
}

export function HeroSection({
  stats,
}: {
  stats: IPublicStat<ExpertStatKey>[];
}) {
  return (
    <section className="relative min-h-[95vh] flex items-center bg-black overflow-hidden">
      {/* Static silver glows over the faint line grid; plain gradients, no blur filters. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{
          background: [
            "radial-gradient(ellipse 40% 35% at 22% 30%, rgba(161,161,170,0.28), transparent 70%)",
            "radial-gradient(ellipse 35% 30% at 78% 32%, rgba(212,212,216,0.18), transparent 70%)",
            "radial-gradient(ellipse 50% 32% at 50% 88%, rgba(113,113,122,0.26), transparent 70%)",
          ].join(", "),
        }}
      />
      <div
        aria-hidden="true"
        className="absolute inset-0 grid-pattern opacity-30"
      />

      <div className="container mx-auto px-4 md:px-6 relative z-10 py-20 md:py-32">
        <div className="max-w-4xl mx-auto text-center">
          {/* Badge */}
          <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-white/5 backdrop-blur-sm border border-white/10 text-zinc-400 text-sm mb-8">
            <Sparkles className="w-4 h-4 text-zinc-300" />
            {/* Claim only what the onboarding process does; no audience counts. */}
            <span>Every expert is vetted before they take a booking</span>
          </div>

          {/* Main headline */}
          <h1 className="text-fluid-5xl font-bold text-white mb-6 leading-tight tracking-tight">
            Learn live from{" "}
            <span className="relative inline-block">
              <span className="silver-text">people who do the work</span>
            </span>
            <br />
            <span className="text-zinc-400">in your field</span>
          </h1>

          {/* Subheadline */}
          <p className="text-lg md:text-xl text-zinc-400 mb-10 max-w-2xl mx-auto leading-relaxed">
            Join live classes and webinars, or book tutoring and private
            sessions with working professionals. Book, pay and learn in one
            place.
          </p>

          {/* CTAs */}
          <div className="flex flex-col sm:flex-row items-center justify-center gap-4 mb-16">
            <Button
              size="lg"
              className="bg-white text-black hover:bg-zinc-200 px-8 h-14 text-base rounded-xl shadow-lg shadow-white/10 group font-medium"
              asChild
            >
              <Link href="/explore/experts">
                Find Your Expert
                <ArrowRight className="ml-2 w-5 h-5 group-hover:translate-x-1 transition-transform" />
              </Link>
            </Button>
            {/* The supply-side CTA lives here now that the navbar carries no
                CTAs. (It replaces a "Watch Demo" button that had no href and
                no handler — it did nothing when clicked.) */}
            <Button
              size="lg"
              variant="outline"
              className="border-zinc-700 bg-transparent text-white hover:bg-zinc-900 hover:text-white px-8 h-14 text-base rounded-xl group"
              asChild
            >
              <Link href="/become-an-expert">
                Become an Expert
                <ArrowRight className="ml-2 w-5 h-5 group-hover:translate-x-1 transition-transform" />
              </Link>
            </Button>
          </div>

          {/* Stats with animated counters. #1490 — every counter here is read
              from the database now, and a figure that is still zero produces no
              tile at all rather than a placeholder. With no data yet the whole
              row is absent, which is why it is rendered conditionally: an empty
              grid would leave a stray divider under the CTAs. */}
          {stats.length > 0 && (
            <div className="grid grid-cols-2 md:grid-cols-3 gap-8 md:gap-12 pt-8 border-t border-zinc-800">
              {stats.map((stat) => (
                <div key={stat.key} className="text-center">
                  <AnimatedNumber value={stat.value} />
                  <div className="text-zinc-400 text-sm mt-1">{stat.label}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Bottom gradient fade */}
      <div className="absolute bottom-0 left-0 right-0 h-32 bg-gradient-to-t from-zinc-950 to-transparent" />
    </section>
  );
}
