import { ArrowRight, Sparkles } from "lucide-react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import type { ExpertStatKey, IPublicStat } from "@/lib/data/public-stats";

const CONSTELLATION_PATHS = [
  "M90 140 L260 230 L420 120 L560 260",
  "M260 230 L200 420 L340 560 L180 720",
  "M1350 150 L1180 240 L1040 130 L900 250",
  "M1180 240 L1250 430 L1100 580 L1270 740",
  "M340 560 L520 800 L760 860 L960 790 L1100 580",
  "M420 120 L720 60 L1040 130",
];

const CONSTELLATION_NODES: [number, number, number][] = [
  [90, 140, 2.5],
  [260, 230, 3.5],
  [420, 120, 2.5],
  [560, 260, 2],
  [200, 420, 3],
  [340, 560, 2.5],
  [180, 720, 2],
  [1350, 150, 2.5],
  [1180, 240, 3.5],
  [1040, 130, 2.5],
  [900, 250, 2],
  [1250, 430, 3],
  [1100, 580, 2.5],
  [1270, 740, 2],
  [520, 800, 2],
  [760, 860, 2.5],
  [960, 790, 2],
  [720, 60, 2.5],
];

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
      {/* Static constellation of nodes and lines framing the text; one inline SVG. */}
      <svg
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 h-full w-full"
        viewBox="0 0 1440 900"
        preserveAspectRatio="xMidYMid slice"
      >
        <g stroke="rgba(255,255,255,0.14)" strokeWidth="1" fill="none">
          {CONSTELLATION_PATHS.map((d) => (
            <path key={d} d={d} />
          ))}
        </g>
        <g fill="rgba(255,255,255,0.35)">
          {CONSTELLATION_NODES.map(([cx, cy, r]) => (
            <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r={r} />
          ))}
        </g>
      </svg>
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse 45% 40% at 50% 45%, rgba(0,0,0,0.85), transparent 75%)",
        }}
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
