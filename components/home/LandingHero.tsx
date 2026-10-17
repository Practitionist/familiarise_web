import type { ReactNode } from "react";
import Link from "next/link";
import { ArrowRight, ArrowUpRight, BadgeCheck } from "lucide-react";
import type { ExpertStatKey, IPublicStat } from "@/lib/data/public-stats";
import { LandingContainer } from "./LandingShared";

export function LandingHero({
  stats,
  preview,
}: {
  stats: IPublicStat<ExpertStatKey>[];
  preview: ReactNode;
}) {
  return (
    <section className="relative overflow-hidden bg-black text-white">
      {/* Retain the original ambient black hero; content never waits for motion. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 overflow-hidden"
      >
        <div className="absolute left-1/4 top-1/4 size-[600px] rounded-full bg-gradient-to-br from-zinc-800/50 to-transparent blur-[50px] motion-safe:animate-blob" />
        <div className="absolute right-0 top-1/3 size-[500px] rounded-full bg-gradient-to-bl from-zinc-700/30 to-transparent blur-[50px] motion-safe:animate-blob animation-delay-2000" />
        <div className="absolute bottom-0 left-1/2 size-[700px] rounded-full bg-gradient-to-t from-zinc-800/40 to-transparent blur-[50px] motion-safe:animate-blob animation-delay-4000" />
        <div className="absolute inset-0 grid-pattern opacity-[0.12]" />
      </div>
      <LandingContainer className="relative pb-10 pt-32 sm:pt-36 lg:pb-12 lg:pt-40">
        <div className="grid items-center gap-14 lg:grid-cols-[1.25fr_1fr] lg:gap-16">
          <div className="max-w-2xl">
            <p className="mb-7 inline-flex items-center gap-2 rounded-full border border-white/15 px-3.5 py-2 text-xs font-medium text-zinc-300">
              <BadgeCheck className="size-4" aria-hidden="true" />
              Verified experts. Personal guidance.
            </p>
            <h1 className="text-[clamp(2.65rem,4.6vw,4.5rem)] font-semibold leading-[1.08] tracking-[-0.055em]">
              <span className="block">The right expert.</span>
              <span className="text-zinc-400">A clearer way forward.</span>
            </h1>
            <p className="mt-7 max-w-lg text-base leading-relaxed text-zinc-300 sm:text-lg">
              One-to-one advice, ongoing mentorship, and live learning—built
              around what you want to do next.
            </p>
            <div className="mt-9 flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-5">
              <Link
                href="/explore/experts"
                className="inline-flex min-h-[52px] items-center justify-center gap-3 rounded-xl bg-white px-6 py-3.5 text-sm font-semibold text-zinc-950 transition-colors hover:bg-zinc-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-white"
              >
                Find an expert{" "}
                <ArrowRight className="size-4" aria-hidden="true" />
              </Link>
              <Link
                href="/explore/programs"
                className="inline-flex min-h-12 items-center justify-center gap-2 rounded-lg px-3 py-3 text-sm font-medium text-white underline-offset-4 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-white"
              >
                Explore programs{" "}
                <ArrowUpRight className="size-4" aria-hidden="true" />
              </Link>
            </div>
            <p className="mt-6 text-xs leading-relaxed text-zinc-400">
              Choose the person, the format, and the next step that feels right.
            </p>
          </div>
          <div className="mx-auto w-full max-w-[440px] lg:ml-auto lg:mr-0">
            {preview}
          </div>
        </div>
        {stats.length > 0 && (
          <dl
            aria-label="Familiarise community"
            className="mt-12 grid grid-cols-2 gap-x-8 gap-y-6 border-t border-white/10 pt-7 sm:mt-16 sm:flex sm:flex-wrap sm:gap-14"
          >
            {stats.map((stat) => (
              <div key={stat.key}>
                <dt className="text-xs text-zinc-400">{stat.label}</dt>
                <dd className="mt-1 text-2xl font-medium tracking-tight tabular-nums">
                  {stat.display}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </LandingContainer>
    </section>
  );
}
