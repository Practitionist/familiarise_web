import { ArrowUpRight, BadgeCheck, BookOpen } from "lucide-react";
import Link from "next/link";
import { FamiliariseMark } from "@/components/brand/FamiliariseLogo";
import {
  homePortrait,
  selectHomeSpotlight,
  type HomeExpert,
} from "@/lib/home/landing-content";
import { LandingPortrait } from "./LandingPortrait";

export function ProductPreview({ experts }: { experts: HomeExpert[] }) {
  const spotlight = selectHomeSpotlight(experts);

  if (!spotlight) {
    return (
      <div className="rounded-3xl border border-white/15 bg-white/[0.04] p-8 text-white">
        <FamiliariseMark className="mb-8 size-12" />
        <p className="text-xs uppercase tracking-[0.16em] text-zinc-400">
          Your next chapter
        </p>
        <h2 className="mt-4 text-2xl font-medium tracking-tight">
          Start with what matters to you.
        </h2>
        <p className="mt-4 leading-relaxed text-zinc-300">
          Explore advice for your next decision, mentorship for the longer
          journey, or a new skill to build.
        </p>
        <Link
          href="/explore/experts"
          className="mt-8 inline-flex min-h-11 items-center gap-2 text-sm font-medium underline-offset-4 hover:underline"
        >
          Explore experts <ArrowUpRight className="size-4" aria-hidden="true" />
        </Link>
      </div>
    );
  }

  const { expert, plan, milestones } = spotlight;
  const profileHref = `/explore/experts/${expert.id}`;
  const detailsHref = plan
    ? `/explore/programs/plans/subscriptions/${plan.id}`
    : profileHref;

  return (
    <aside aria-label="Expert and offering preview" className="relative">
      <div className="pointer-events-none absolute -inset-4 rounded-[40px] border border-white/[0.06]" />
      <div className="overflow-hidden rounded-3xl bg-[#fafaf7] text-zinc-950 shadow-2xl shadow-black/20">
        <div className="flex items-center justify-between border-b border-zinc-200/80 px-6 py-4">
          <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-zinc-500">
            A closer look
          </span>
          <FamiliariseMark className="size-6 text-zinc-800" />
        </div>
        <div className="p-6 sm:p-7">
          <Link
            href={profileHref}
            className="group flex items-center gap-4 rounded-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4"
          >
            <LandingPortrait
              name={expert.user.name}
              src={homePortrait(expert)}
              className="size-20 shrink-0 rounded-2xl"
              sizes="80px"
            />
            <div className="min-w-0">
              <p className="mb-1 flex items-center gap-1.5 text-xs text-zinc-600">
                <BadgeCheck className="size-3.5" aria-hidden="true" /> Verified
                expert
              </p>
              <h2 className="text-xl font-semibold leading-snug tracking-tight group-hover:underline">
                {expert.user.name}
              </h2>
              <p className="mt-1 line-clamp-2 text-sm leading-relaxed text-zinc-600">
                {expert.headline || expert.domain?.name}
              </p>
            </div>
          </Link>
          <div className="my-6 h-px bg-zinc-200/80" />
          {plan ? (
            <>
              <p className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-500">
                <BookOpen className="size-3.5" aria-hidden="true" /> Ongoing
                mentorship
              </p>
              <h3 className="mt-3 text-xl font-medium leading-snug tracking-tight">
                {plan.title}
              </h3>
              {milestones.length > 0 ? (
                <ol aria-label="Curriculum preview" className="mt-5 space-y-3">
                  {milestones.map((milestone, index) => (
                    <li
                      key={milestone.id}
                      className="flex items-start gap-3 text-sm leading-relaxed"
                    >
                      <span
                        className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border border-zinc-200 text-[10px] text-zinc-500"
                        aria-hidden="true"
                      >
                        {String(index + 1).padStart(2, "0")}
                      </span>
                      <span className="line-clamp-2">{milestone.title}</span>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="mt-4 text-sm leading-relaxed text-zinc-600">
                  Get to know the offering and review what&apos;s included
                  before you choose.
                </p>
              )}
            </>
          ) : (
            <>
              <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-500">
                Their areas of expertise
              </p>
              <div className="mt-4 flex flex-wrap gap-2">
                {expert.tags.slice(0, 3).map((tag) => (
                  <span
                    key={tag.id}
                    className="rounded-full border border-zinc-200 px-3 py-1.5 text-xs text-zinc-700"
                  >
                    {tag.name}
                  </span>
                ))}
              </div>
              <p className="mt-4 text-sm leading-relaxed text-zinc-600">
                See their experience, approach, and available offerings on their
                profile.
              </p>
            </>
          )}
          <Link
            href={detailsHref}
            className="mt-6 flex min-h-12 items-center justify-between gap-3 rounded-xl bg-zinc-950 px-4 py-3 text-sm font-medium text-white transition-colors hover:bg-zinc-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-zinc-900"
          >
            {plan ? "Explore this plan" : "Meet this expert"}
            <ArrowUpRight className="size-4 shrink-0" aria-hidden="true" />
          </Link>
          <p className="mt-3 text-center text-[11px] leading-relaxed text-zinc-500">
            Review full details before booking. No commitment to explore.
          </p>
        </div>
      </div>
    </aside>
  );
}
