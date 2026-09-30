import Link from "next/link";
import { ArrowDown, ArrowUpRight, Search, Sparkles } from "lucide-react";

interface ExploreHeroProps {
  kind: "experts" | "programs";
  stats: { key: string; display: string; label: string }[];
}

/** Shared editorial header. Statistics always come from the catalog. */
export function ExploreHero({ kind, stats }: ExploreHeroProps) {
  const experts = kind === "experts";
  return (
    <section className="explore-hero">
      <div className="explore-container grid items-center gap-10 lg:grid-cols-[1.35fr_1fr]">
        <div>
          <p className="explore-eyebrow mb-5">
            <Sparkles className="h-4 w-4" /> A little guidance. A bigger
            possibility.
          </p>
          <h1 className="max-w-3xl text-fluid-5xl font-semibold leading-[1.08] tracking-[-0.04em]">
            {experts ? (
              <>
                Find your people.
                <br />
                <span className="explore-highlight">Move forward.</span>
              </>
            ) : (
              <>
                Make room for
                <br />
                <span className="explore-highlight">something new.</span>
              </>
            )}
          </h1>
          <p className="mt-6 max-w-xl text-lg leading-relaxed text-muted-foreground">
            {experts
              ? "Meet experts who have been where you want to go. Find thoughtful guidance for your next step."
              : "Explore expert-led classes and live webinars. New perspectives, practical skills, and people to learn with."}
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <a
              className="explore-primary-link"
              href={experts ? "#all-experts" : "#all-programs"}
            >
              <Search className="h-4 w-4" />{" "}
              {experts ? "Find an expert" : "Find a program"}
              <ArrowDown className="h-4 w-4" />
            </a>
            <Link
              className="inline-flex items-center gap-2 rounded-xl px-3 py-3 text-sm font-medium text-zinc-300 hover:bg-white/5 hover:text-white"
              href={experts ? "/explore/programs" : "/explore/experts"}
            >
              {experts ? "Explore programs" : "Meet the experts"}
              <ArrowUpRight className="h-4 w-4" />
            </Link>
          </div>
        </div>
        <div className="explore-hero-note">
          <span className="explore-eyebrow">
            {experts ? "Your next chapter" : "Follow your curiosity"}
          </span>
          <p className="my-7 text-3xl font-medium leading-tight tracking-tight sm:text-4xl">
            {experts
              ? "A good conversation can change your direction."
              : "Small beginnings. Lasting possibilities."}
          </p>
          <div className="flex flex-wrap gap-x-8 gap-y-4 border-t border-white/10 pt-5">
            {stats.length ? (
              stats.map((stat) => (
                <div key={stat.key}>
                  <p className="text-2xl font-semibold tabular-nums">
                    {stat.display}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {stat.label}
                  </p>
                </div>
              ))
            ) : (
              <p className="text-sm text-muted-foreground">
                {experts
                  ? "Discover newly verified experts."
                  : "Discover new classes and webinars."}
              </p>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
