"use client";

import { memo } from "react";
import { RegistrationBadge } from "@/components/ui/registration-badge";
import { ArrowRight, Flame, Sparkles, Star } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useCurrency } from "@/hooks/useCurrency";
import { CompanyLogo } from "@/components/ui/company-logo";
import { isClassProgram, Program } from "@/lib/explore/programs";
import { programHref } from "@/lib/explore/hrefs";
import { ExploreCard } from "@/components/explore/ExploreCard";
import { displayedScore } from "@/lib/reviews-display";

type ProgramCardVariant = "grid" | "list" | "carousel";
export type ProgramBadge = "featured" | "trending" | "new";

interface ProgramCardProps {
  program: Program;
  variant?: ProgramCardVariant;
  badge?: ProgramBadge;
  /** #664 — viewer's ACTIVE org memberships as { orgId: orgName }. */
  viewerOrgs?: Record<string, string>;
}

// Curation state is a neutral taxonomy, not a status — so these use the
// `secondary`/`outline` badge variants rather than the reserved status colours.
// The editorial pick takes the brand, which is the one place on the card where
// a saturated fill earns its keep: it is the difference between "someone chose
// this" and "this is popular".
const badgeConfig: Record<
  ProgramBadge,
  { label: string; icon: React.ReactNode; className: string }
> = {
  featured: {
    label: "Familiarise Pick",
    icon: <Sparkles className="h-3 w-3" />,
    className: "bg-brand text-brand-foreground border-transparent",
  },
  trending: {
    label: "Trending",
    icon: <Flame className="h-3 w-3" />,
    className: "bg-card/95 text-foreground border-border backdrop-blur",
  },
  new: {
    label: "New",
    icon: <Sparkles className="h-3 w-3" />,
    className: "bg-card/95 text-foreground border-border backdrop-blur",
  },
};

/**
 * `backdrop-blur` on the image overlays is what makes them survive an
 * arbitrary cover photo. A solid pill over a white thumbnail was invisible;
 * the old code leaned on `bg-black/70` for one of them and nothing for the
 * others.
 */
function TypeBadge({ type }: { type: "class" | "webinar" }) {
  return (
    <span
      className={`inline-flex items-center rounded-chip border px-2 py-0.5 text-xs font-medium backdrop-blur ${
        type === "class"
          ? "border-transparent bg-brand text-brand-foreground"
          : "border-border bg-card/95 text-foreground"
      }`}
    >
      {type === "class" ? "Class" : "Webinar"}
    </span>
  );
}

function ExtraBadge({ badge }: { badge: ProgramBadge }) {
  const config = badgeConfig[badge];
  return (
    <span
      className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium ${config.className}`}
    >
      {config.icon}
      {config.label}
    </span>
  );
}

/**
 * The star on a program card: the GROUP score or nothing (#1566) — a group
 * product never wears a 1:1 reputation. NULL means suppressed, no star.
 */
function getProgramRating(program: Program): number | null {
  const profile = program.consultantProfile;
  if (!profile) return null;
  return displayedScore(
    {
      publishedRatingOneToOne: profile.publishedRatingOneToOne ?? null,
      publishedRatingGroup: profile.publishedRatingGroup ?? null,
    },
    "GROUP",
  ).score;
}

/** Extract consultant headline from plan data if available. */
function getProgramInstructor(program: Program): { headline: string } | null {
  const headline = program.consultantProfile?.headline;
  if (headline) return { headline };
  return null;
}

/** Extract instructor work experiences (for company logo stickers), including collaborator experiences (deduplicated). */
function getInstructorWorkExperiences(program: Program): Array<{
  company: string;
  companyDomain: string | null;
  isCurrent: boolean;
}> {
  const primaryExps = program.consultantProfile?.user?.workExperiences ?? [];

  // Merge collaborator work experiences
  const collaborators = program.collaborators;
  if (!collaborators?.length) return primaryExps;

  const seen = new Set(primaryExps.map((e) => e.company.toLowerCase()));
  const merged = [...primaryExps];
  for (const collab of collaborators) {
    for (const exp of collab.consultantProfile?.user?.workExperiences ?? []) {
      const key = exp.company.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        merged.push(exp);
      }
    }
  }
  return merged;
}

/**
 * Detail URL for a program card. Single source so every variant links the
 * same destination — and, as a plain `href`, every card is hover-prefetched
 * by Next instead of cold-loading on click (was: div[role=button] +
 * router.push, which defeats prefetch entirely).
 */
function planHref(program: Program): string {
  return programHref(program);
}

function GridCard({
  program,
  badge,
}: {
  program: Program;
  badge?: ProgramBadge;
}) {
  const { formatPrice } = useCurrency();
  const rating = getProgramRating(program);
  const instructor = getProgramInstructor(program);
  const workExperiences = getInstructorWorkExperiences(program);

  return (
    <Link href={planHref(program)} aria-label={`View details for ${program.title}`}>
      <ExploreCard className="flex h-full cursor-pointer flex-col overflow-hidden">
      <div className="relative aspect-[16/10] overflow-hidden">
        <Image
          src={program.imageUrl}
          alt={program.title}
          fill
          className="object-cover group-hover:scale-105 transition-transform duration-500"
          sizes="(max-width: 768px) 100vw, (max-width: 1200px) 50vw, 33vw"
        />
        <div className="absolute top-3 left-3 flex gap-2">
          <TypeBadge type={program.type} />
          {program.isRegistered && (
            <RegistrationBadge
              type={isClassProgram(program) ? "class" : "webinar"}
              compact
            />
          )}
        </div>
        {badge && (
          <div className="absolute top-3 right-3">
            <ExtraBadge badge={badge} />
          </div>
        )}
      </div>

      <div className="p-5 flex-1 flex flex-col">
        <h3 className="mb-2 line-clamp-1 font-display text-base font-semibold leading-snug tracking-tight text-foreground transition-colors group-hover:text-brand-foreground-subtle">
          {program.title}
        </h3>
        <p className="text-sm text-muted-foreground mb-4 line-clamp-2 flex-1">
          {program.description}
        </p>

        {/* Instructor info + company logos */}
        {(instructor || workExperiences.length > 0) && (
          <div className="flex items-center gap-2 mb-3">
            {workExperiences.slice(0, 2).map((exp, i) => (
              <CompanyLogo
                key={`grid-company-${program.id}-${i}`}
                companyName={exp.company}
                companyDomain={exp.companyDomain ?? undefined}
                size={20}
                className="border-border"
              />
            ))}
            {instructor && (
              <span className="text-xs text-muted-foreground/70 line-clamp-1">
                {instructor.headline}
              </span>
            )}
          </div>
        )}

        <div className="flex items-center justify-between pt-4 border-t border-border">
          <div className="flex items-center gap-2">
            <div className="tnum font-display text-lg font-bold text-foreground">
              {formatPrice(program.price)}
            </div>
            {rating !== null && (
              <div className="flex items-center gap-0.5 ml-1">
                <Star className="w-3.5 h-3.5 fill-amber-400 text-amber-400" />
                <span className="text-xs font-medium text-muted-foreground">
                  {rating.toFixed(1)}
                </span>
              </div>
            )}
          </div>
          <div className="flex items-center gap-1 text-sm font-medium text-muted-foreground group-hover:text-foreground transition-colors">
            <span>View Details</span>
            <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
          </div>
        </div>

        <div className="flex items-center gap-1 mt-2">
          <Image
            src="/avif/static/assets/logos/images/logos/Familiarise-logos_transparent.avif"
            alt="Familiarise"
            width={12}
            height={12}
          />
          <span className="text-xs text-muted-foreground">
            on Familiarise
          </span>
        </div>
      </div>
      </ExploreCard>
    </Link>
  );
}

function ListCard({
  program,
  badge,
}: {
  program: Program;
  badge?: ProgramBadge;
}) {
  const { formatPrice } = useCurrency();
  const rating = getProgramRating(program);
  const instructor = getProgramInstructor(program);
  const workExperiences = getInstructorWorkExperiences(program);

  return (
    <Link href={planHref(program)} aria-label={`View details for ${program.title}`}>
      <ExploreCard className="flex cursor-pointer overflow-hidden">
      <div className="relative w-48 md:w-64 flex-shrink-0">
        <Image
          src={program.imageUrl}
          alt={program.title}
          fill
          className="object-cover"
          sizes="256px"
        />
        <div className="absolute top-3 left-3 flex gap-2">
          <TypeBadge type={program.type} />
          {badge && <ExtraBadge badge={badge} />}
        </div>
      </div>

      <div className="p-6 flex-1 flex flex-col justify-between min-w-0">
        <div>
          <div className="flex items-start justify-between gap-4 mb-2">
            <h3 className="font-display text-base font-semibold leading-snug tracking-tight text-foreground group-hover:text-brand-foreground-subtle transition-colors">
              {program.title}
            </h3>
            {program.isRegistered && (
              <RegistrationBadge
                type={isClassProgram(program) ? "class" : "webinar"}
                compact
              />
            )}
          </div>
          <p className="text-sm text-muted-foreground line-clamp-2">
            {program.description}
          </p>
          {/* Instructor info + company logos */}
          {(instructor || workExperiences.length > 0) && (
            <div className="flex items-center gap-2 mt-2">
              {workExperiences.slice(0, 3).map((exp, i) => (
                <CompanyLogo
                  key={`list-company-${program.id}-${i}`}
                  companyName={exp.company}
                  companyDomain={exp.companyDomain ?? undefined}
                  size={22}
                  className="border-border"
                />
              ))}
              {instructor && (
                <span className="text-xs text-muted-foreground/70 line-clamp-1">
                  {instructor.headline}
                </span>
              )}
            </div>
          )}
        </div>

        <div>
          <div className="flex items-center justify-between mt-4">
            <div className="flex items-center gap-2">
              <div className="tnum font-display text-lg font-bold text-foreground">
                {formatPrice(program.price)}
              </div>
              {rating !== null && (
                <div className="flex items-center gap-0.5 ml-1">
                  <Star className="w-3.5 h-3.5 fill-amber-400 text-amber-400" />
                  <span className="text-xs font-medium text-muted-foreground">
                    {rating.toFixed(1)}
                  </span>
                </div>
              )}
            </div>
            {/* Not a <Button>: this sits inside the card <Link>, and a
                <button> inside an <a> is invalid HTML. Same outline look. */}
            <span className="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-xl border border-border bg-background px-4 py-2 text-sm font-medium transition-colors hover:bg-muted">
              View Details
              <ArrowRight className="w-4 h-4 ml-2" />
            </span>
          </div>
          <div className="flex items-center gap-1 mt-2">
            <Image
              src="/avif/static/assets/logos/images/logos/Familiarise-logos_transparent.avif"
              alt="Familiarise"
              width={12}
              height={12}
            />
            <span className="text-xs text-muted-foreground">
              on Familiarise
            </span>
          </div>
        </div>
      </div>
      </ExploreCard>
    </Link>
  );
}

function CarouselCard({
  program,
  badge,
}: {
  program: Program;
  badge?: ProgramBadge;
}) {
  const { formatPrice } = useCurrency();
  const workExperiences = getInstructorWorkExperiences(program);

  return (
    <Link href={planHref(program)} aria-label={`View details for ${program.title}`}>
      <ExploreCard className="flex w-[300px] shrink-0 cursor-pointer flex-col overflow-hidden md:w-[340px]">
      <div className="relative aspect-[16/10] overflow-hidden">
        <Image
          src={program.imageUrl}
          alt={program.title}
          fill
          className="object-cover group-hover:scale-105 transition-transform duration-500"
          sizes="360px"
        />
        <div className="absolute top-3 left-3 flex gap-2">
          <TypeBadge type={program.type} />
        </div>
        {badge && (
          <div className="absolute top-3 right-3">
            <ExtraBadge badge={badge} />
          </div>
        )}
      </div>

      <div className="p-4">
        <h3 className="mb-1 line-clamp-1 font-display text-base font-semibold leading-snug tracking-tight text-foreground group-hover:text-brand-foreground-subtle transition-colors">
          {program.title}
        </h3>
        <p className="text-sm text-muted-foreground line-clamp-1 mb-3">
          {program.description}
        </p>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="tnum font-display text-lg font-bold text-foreground">
              {formatPrice(program.price)}
            </div>
            {workExperiences.length > 0 && (
              <div className="flex items-center gap-1">
                {workExperiences.slice(0, 2).map((exp, i) => (
                  <CompanyLogo
                    key={`carousel-company-${program.id}-${i}`}
                    companyName={exp.company}
                    companyDomain={exp.companyDomain ?? undefined}
                    size={18}
                    className="border-border"
                  />
                ))}
              </div>
            )}
          </div>
          <div className="flex items-center gap-1 text-sm font-medium text-muted-foreground group-hover:text-foreground transition-colors">
            <span>View</span>
            <ArrowRight className="w-3.5 h-3.5 group-hover:translate-x-1 transition-transform" />
          </div>
        </div>
      </div>
      </ExploreCard>
    </Link>
  );
}

function ProgramCardImpl({
  program,
  variant = "grid",
  badge,
  viewerOrgs,
}: ProgramCardProps) {
  const card = (() => {
    switch (variant) {
      case "list":
        return <ListCard program={program} badge={badge} />;
      case "carousel":
        return <CarouselCard program={program} badge={badge} />;
      default:
        return <GridCard program={program} badge={badge} />;
    }
  })();

  // #664 — badge a plan the viewer's org sponsors. Rendered as a chip above the
  // card (no collision with the type/registration/extra badges on the image).
  const orgName = program.organizationId
    ? viewerOrgs?.[program.organizationId]
    : undefined;
  if (!orgName) return card;

  return (
    <div className="flex flex-col gap-1.5">
      <span className="inline-flex w-fit items-center gap-1 rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-medium text-primary">
        Recommended by {orgName}
      </span>
      {card}
    </div>
  );
}

const ProgramCard = memo(ProgramCardImpl);
export default ProgramCard;
