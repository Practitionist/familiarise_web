import Link from "next/link";
import { ArrowUpRight, BadgeCheck, Star } from "lucide-react";
import { homePortrait, type HomeExpert } from "@/lib/home/landing-content";
import { LandingPortrait } from "./LandingPortrait";
import {
  LandingContainer,
  LandingTextLink,
  SectionIntro,
} from "./LandingShared";

export interface LandingDomain {
  id: string;
  name: string;
  count: number;
}

export function LandingDiscovery({
  experts,
  domains,
}: {
  experts: HomeExpert[];
  domains: LandingDomain[];
}) {
  if (!experts.length) return null;

  return (
    <section
      aria-labelledby="landing-experts-heading"
      className="bg-white py-16 sm:py-20 lg:py-24"
    >
      <LandingContainer>
        <div className="flex flex-col justify-between gap-6 sm:flex-row sm:items-end">
          <SectionIntro
            id="landing-experts-heading"
            eyebrow="People, not just profiles"
            title={
              <>
                A fresh perspective.
                <br />
                The experience to back it up.
              </>
            }
            description="Find someone who knows your field, understands your goals, and can help you move forward."
          />
          <LandingTextLink href="/explore/experts" className="shrink-0">
            Meet all experts
          </LandingTextLink>
        </div>
        <div
          role="region"
          aria-label="Expert profiles"
          tabIndex={0}
          className="mt-10 flex snap-x snap-mandatory gap-5 overflow-x-auto pb-3 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 sm:grid sm:grid-cols-2 sm:overflow-visible sm:pb-0 lg:grid-cols-4"
        >
          {experts.slice(0, 4).map((expert) => (
            <Link
              key={expert.id}
              href={`/explore/experts/${expert.id}`}
              className="group flex w-[min(280px,78vw)] min-w-0 shrink-0 snap-start flex-col overflow-hidden rounded-2xl border border-zinc-200 transition-colors hover:border-zinc-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-zinc-900 sm:w-auto"
            >
              <LandingPortrait
                name={expert.user.name}
                src={homePortrait(expert)}
              />
              <div className="flex flex-1 flex-col p-5">
                <p className="mb-2 flex items-center gap-1.5 text-[11px] font-medium text-zinc-500">
                  <BadgeCheck className="size-3.5" aria-hidden="true" />
                  {expert.domain?.name || "Verified expert"}
                </p>
                <h3 className="text-lg font-semibold tracking-tight text-zinc-950">
                  {expert.user.name}
                </h3>
                <p className="mt-2 line-clamp-2 min-h-10 text-sm leading-relaxed text-zinc-600">
                  {expert.headline ||
                    "Explore their experience and available offerings."}
                </p>
                <div className="mt-5 flex flex-wrap items-center gap-2 text-xs text-zinc-600">
                  {expert.rating !== null && (
                    <span className="inline-flex items-center gap-1">
                      <Star
                        className="size-3 fill-current"
                        aria-hidden="true"
                      />
                      {expert.rating.toFixed(1)}
                      {expert.reviewCount ? ` (${expert.reviewCount})` : ""}
                    </span>
                  )}
                  {expert.experience !== null && expert.experience > 0 && (
                    <span>
                      {expert.experience}{" "}
                      {expert.experience === 1 ? "year" : "years"} of experience
                    </span>
                  )}
                </div>
                <div className="mt-5 flex items-center justify-between border-t border-zinc-100 pt-4 text-xs font-medium text-zinc-900">
                  <span>Meet {expert.user.name.split(" ")[0]}</span>
                  <ArrowUpRight className="size-4" aria-hidden="true" />
                </div>
              </div>
            </Link>
          ))}
        </div>
        <p className="mt-3 text-xs text-zinc-500 sm:hidden">
          Swipe or use the arrow keys to meet more experts.
        </p>
        {domains.length > 0 && (
          <div className="mt-9 flex flex-col gap-4 border-t border-zinc-200 pt-7 sm:flex-row sm:items-start sm:gap-6">
            <p className="pt-3 text-xs font-medium text-zinc-500 sm:shrink-0">
              Explore your field
            </p>
            <nav
              aria-label="Explore experts by field"
              className="flex flex-wrap gap-2"
            >
              {domains.slice(0, 6).map((domain) => (
                <Link
                  key={domain.id}
                  href={`/explore/experts?domain=${encodeURIComponent(domain.id)}`}
                  className="inline-flex min-h-11 items-center rounded-full border border-zinc-200 px-4 py-2 text-xs text-zinc-700 transition-colors hover:border-zinc-400 hover:bg-zinc-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                >
                  {domain.name}
                </Link>
              ))}
            </nav>
          </div>
        )}
      </LandingContainer>
    </section>
  );
}
