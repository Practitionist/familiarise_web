import { Sparkles } from "lucide-react";

import type { ExpertStatKey, IPublicStat } from "@/lib/data/public-stats";
import { HeroPreviewCard, HeroSearchControls } from "./HeroInteractiveControls";

function AnimatedNumber({
  value,
  suffix = "",
}: {
  value: number;
  suffix?: string;
}) {
  return (
    <span className="text-3xl md:text-4xl font-bold text-white tabular-nums tracking-tight">
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
    <section className="relative bg-zinc-950 text-white pt-32 pb-20 md:pb-28 overflow-hidden">
      {/* Subtle radial spotlight + grid pattern */}
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_80%_50%_at_50%_-20%,rgba(255,255,255,0.08),transparent)]" />
      <div className="pointer-events-none absolute inset-0 grid-pattern opacity-20" />

      <div className="max-w-[1400px] mx-auto px-4 sm:px-8 xl:px-12 relative z-10">
        <div className="grid lg:grid-cols-12 gap-12 lg:gap-10 items-center">
          {/* Left column: Headline, Inline Search, Domain Pills & Verified Stats */}
          <div className="lg:col-span-7">
            <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-white/[0.06] border border-white/10 text-zinc-300 text-xs font-medium mb-6">
              <Sparkles className="w-3.5 h-3.5 text-zinc-300" />
              {/* #1490 — enforced by the directory reads themselves: only VERIFIED profiles are public. */}
              <span>Every expert is verified before they are listed</span>
            </div>

            <h1 className="text-fluid-4xl md:text-fluid-5xl font-bold text-white mb-6 leading-[1.08] tracking-tight">
              Learn directly from the{" "}
              <span className="silver-text">best minds</span>{" "}
              <span className="text-zinc-400">in your industry</span>
            </h1>

            <p className="text-base md:text-lg text-zinc-400 mb-8 max-w-2xl leading-relaxed">
              Book 1-on-1 consultations, ongoing mentorship subscriptions,
              cohort classes, and live webinars with verified practitioners —
              backed by built-in HD video and escrow payment protection.
            </p>

            <HeroSearchControls />

            {/* Real Database Stats (#1490) */}
            {stats.length > 0 && (
              <dl className="grid grid-cols-2 sm:grid-cols-3 gap-6 pt-8 border-t border-white/[0.08] max-w-xl">
                {stats.map((stat) => (
                  <div key={stat.key}>
                    <dd>
                      <AnimatedNumber value={stat.value} />
                    </dd>
                    <dt className="text-xs text-zinc-400 mt-1 font-medium">
                      {stat.label}
                    </dt>
                  </div>
                ))}
              </dl>
            )}
          </div>

          {/* Right column: Interactive Session & Booking Architecture Preview */}
          <div className="lg:col-span-5">
            <HeroPreviewCard />
          </div>
        </div>
      </div>
    </section>
  );
}
