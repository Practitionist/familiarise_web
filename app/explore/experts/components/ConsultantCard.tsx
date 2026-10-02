"use client";

import { memo } from "react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import Image from "next/image";
import Link from "next/link";
import type { IConsultantCardData } from "@/types/consultant";
import { CompanyLogo } from "@/components/ui/company-logo";
import {
  Star,
  Clock,
  Briefcase,
  Globe,
  ArrowRight,
  CheckCircle2,
  BadgeCheck,
  Building2,
} from "lucide-react";
import { useCurrency } from "@/hooks/useCurrency";

type ClassPlanSummary = {
  id: string;
  title: string;
  price: number;
  durationInMonths?: number;
};

type ExtendedConsultantCardData = IConsultantCardData & {
  classPlans?: ClassPlanSummary[];
};

interface ConsultantCardProps {
  consultant: ExtendedConsultantCardData;
  metadata: {
    domains: { id: string; name: string }[];
    subdomains: { id: string; name: string }[];
    tags: { id: string; name: string }[];
  } | null;
  /** Opens the quick-view details drawer instead of navigating. */
  onSelect?: (consultant: IConsultantCardData) => void;
}

interface SubscriptionPlanCardData {
  id: string;
  price: number;
  durationInMonths: number;
  sessionsPerWeek: number | null;
  emailSupport: string | null;
  totalSessions: number | null;
}

/**
 * Returns true if `value` is a non-empty string that isn't one of the
 * placeholder sentinels users/seeds sometimes leave behind ("none", "n/a", …).
 */
const isMeaningfulText = (
  value: string | null | undefined,
): value is string => {
  if (!value) return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  return !/^(none|n\/?a|na|null|nil|tbd|-+|\.+)$/i.test(trimmed);
};

function formatDuration(months: number): string {
  switch (months) {
    case 1:
      return "1 month";
    case 3:
      return "3 months";
    case 6:
      return "6 months";
    case 12:
      return "1 year";
    default:
      return `${months} months`;
  }
}

function getSecondaryGridClass(count: number): string {
  if (count === 3) return "grid-cols-1 sm:grid-cols-3";
  if (count === 2) return "grid-cols-2";
  return "grid-cols-1";
}

function buildTabLabels(
  sortedPlans: readonly { durationInMonths: number }[],
): string[] {
  const durationCounts = sortedPlans.reduce<Record<number, number>>(
    (acc, plan) => {
      acc[plan.durationInMonths] = (acc[plan.durationInMonths] || 0) + 1;
      return acc;
    },
    {},
  );
  const durationSeen: Record<number, number> = {};
  return sortedPlans.map((plan) => {
    const base = `${plan.durationInMonths} Mo`;
    if (durationCounts[plan.durationInMonths] > 1) {
      durationSeen[plan.durationInMonths] =
        (durationSeen[plan.durationInMonths] || 0) + 1;
      return `${base} (${durationSeen[plan.durationInMonths]})`;
    }
    return base;
  });
}

function SubscriptionPlanCard({
  plan,
  formatPrice,
}: Readonly<{
  plan: SubscriptionPlanCardData;
  formatPrice: (amountINR: number) => string;
}>) {
  const hasWeeklySessions =
    plan.sessionsPerWeek !== null &&
    plan.sessionsPerWeek !== undefined &&
    plan.sessionsPerWeek > 0;
  const hasTotalSessions =
    plan.totalSessions !== null &&
    plan.totalSessions !== undefined &&
    plan.totalSessions > 0;

  return (
    <div className="bg-card rounded-xl p-5 border border-border">
      <div className="flex flex-wrap items-baseline justify-between gap-2 mb-4">
        <div className="text-2xl sm:text-3xl font-bold text-foreground">
          {formatPrice(plan.price)}
        </div>
        <div className="text-xs sm:text-sm text-muted-foreground font-medium bg-muted px-2 sm:px-3 py-1 rounded-full whitespace-nowrap">
          {formatDuration(plan.durationInMonths)}
        </div>
      </div>
      <div className="space-y-2.5">
        {hasWeeklySessions && (
          <div className="flex items-center gap-2 text-sm">
            <CheckCircle2 className="w-4 h-4 text-emerald-500" />
            <span className="text-muted-foreground">
              {plan.sessionsPerWeek}{" "}
              {plan.sessionsPerWeek === 1 ? "session" : "sessions"}
              /week
            </span>
          </div>
        )}
        {plan.emailSupport && (
          <div className="flex items-center gap-2 text-sm">
            <CheckCircle2 className="w-4 h-4 text-emerald-500" />
            <span className="text-muted-foreground capitalize">
              {plan.emailSupport.toLowerCase()} email support
            </span>
          </div>
        )}
        {hasTotalSessions && (
          <div className="flex items-center gap-2 text-sm">
            <CheckCircle2 className="w-4 h-4 text-emerald-500" />
            <span className="text-muted-foreground">
              {plan.totalSessions}{" "}
              {plan.totalSessions === 1 ? "session" : "sessions"} total
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

function StartingOfferingCard({
  startingConsultation,
  consultationCount,
  startingClass,
  profileHref,
  formatPrice,
}: Readonly<{
  startingConsultation: {
    price: number;
    durationInHours: number;
    title?: string | null;
  } | null;
  consultationCount: number;
  startingClass: ClassPlanSummary | null;
  profileHref: string;
  formatPrice: (amountINR: number) => string;
}>) {
  if (startingConsultation) {
    return (
      <div className="bg-card rounded-xl p-5 border border-border space-y-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div className="text-2xl sm:text-3xl font-bold text-foreground">
            {formatPrice(startingConsultation.price)}
          </div>
          <div className="text-xs sm:text-sm text-muted-foreground font-medium bg-muted px-2.5 py-1 rounded-full whitespace-nowrap">
            {startingConsultation.durationInHours}h session
          </div>
        </div>
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-sm">
            <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" />
            <span className="text-muted-foreground truncate">
              {startingConsultation.title || "1:1 Consultation"}
            </span>
          </div>
          {consultationCount > 1 && (
            <div className="flex items-center gap-2 text-sm">
              <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" />
              <span className="text-muted-foreground">
                {consultationCount} consultation options
              </span>
            </div>
          )}
        </div>
        <Button
          asChild
          variant="outline"
          className="w-full h-10 rounded-xl text-sm font-medium border-border"
        >
          <Link href={profileHref}>Book 1:1 Session</Link>
        </Button>
      </div>
    );
  }

  if (startingClass) {
    return (
      <div className="bg-card rounded-xl p-5 border border-border space-y-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div className="text-2xl sm:text-3xl font-bold text-foreground">
            {formatPrice(startingClass.price)}
          </div>
          {startingClass.durationInMonths && (
            <div className="text-xs sm:text-sm text-muted-foreground font-medium bg-muted px-2.5 py-1 rounded-full whitespace-nowrap">
              {startingClass.durationInMonths} mo class
            </div>
          )}
        </div>
        <div className="flex items-center gap-2 text-sm">
          <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" />
          <span className="text-muted-foreground truncate">
            {startingClass.title || "Group Class"}
          </span>
        </div>
        <Button
          asChild
          variant="outline"
          className="w-full h-10 rounded-xl text-sm font-medium border-border"
        >
          <Link href={profileHref}>Explore Class</Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="bg-card rounded-xl p-5 border border-border space-y-3">
      <p className="text-sm font-medium text-foreground">
        1:1 Sessions &amp; Mentorship
      </p>
      <p className="text-xs text-muted-foreground">
        View profile for available sessions and scheduling options.
      </p>
      <Button
        asChild
        variant="outline"
        className="w-full h-10 rounded-xl text-sm font-medium border-border"
      >
        <Link href={profileHref}>Book 1:1 Session</Link>
      </Button>
    </div>
  );
}

function ConsultantOfferingsPanel({
  consultantId,
  sortedPlans,
  tabLabels,
  startingConsultation,
  consultationCount,
  startingClass,
  profileHref,
  formatPrice,
}: Readonly<{
  consultantId: string;
  sortedPlans: readonly SubscriptionPlanCardData[];
  tabLabels: readonly string[];
  startingConsultation: {
    price: number;
    durationInHours: number;
    title?: string | null;
  } | null;
  consultationCount: number;
  startingClass: ClassPlanSummary | null;
  profileHref: string;
  formatPrice: (amountINR: number) => string;
}>) {
  if (sortedPlans.length > 0) {
    return (
      <Tabs defaultValue={sortedPlans[0].id} className="w-full">
        <TabsList className="w-full mb-4 bg-card p-1 rounded-lg border border-border">
          {sortedPlans.map((plan, index) => (
            <TabsTrigger
              key={`${consultantId}-tab-trigger-${plan.id}`}
              value={plan.id}
              className="flex-1 data-[state=active]:bg-primary data-[state=active]:text-primary-foreground rounded-md text-sm font-medium transition-all duration-200"
            >
              {tabLabels[index]}
            </TabsTrigger>
          ))}
        </TabsList>
        {sortedPlans.map((plan) => (
          <TabsContent
            key={`${consultantId}-tab-content-${plan.id}`}
            value={plan.id}
          >
            <SubscriptionPlanCard plan={plan} formatPrice={formatPrice} />
          </TabsContent>
        ))}
      </Tabs>
    );
  }

  return (
    <StartingOfferingCard
      startingConsultation={startingConsultation}
      consultationCount={consultationCount}
      startingClass={startingClass}
      profileHref={profileHref}
      formatPrice={formatPrice}
    />
  );
}

function ConsultantDetailsSummary({
  consultant,
  onSelect,
}: Readonly<{
  consultant: ExtendedConsultantCardData;
  onSelect?: (consultant: IConsultantCardData) => void;
}>) {
  const workExperiences = consultant.user.workExperiences ?? [];
  const hasTaxonomy = Boolean(
    consultant.domain?.name ||
      consultant.subDomains.length > 0 ||
      consultant.tags.length > 0,
  );
  const reviewTotal = consultant.reviewCount ?? consultant.reviews?.length ?? 0;

  return (
    <div
      className={`relative flex-grow ${onSelect ? "cursor-pointer" : ""}`}
      {...(onSelect
        ? {
            onClick: (e: React.MouseEvent) => {
              if ((e.target as HTMLElement).closest("a,button")) return;
              onSelect(consultant);
            },
          }
        : {})}
    >
      {/* Header */}
      <div className="flex items-start gap-4 mb-5">
        <div className="relative h-20 w-20 flex-shrink-0">
          <Image
            alt={`Portrait of ${consultant.user.name}`}
            className="rounded-2xl object-cover ring-2 ring-muted"
            src={consultant.user.image || "/placeholder-user.jpg"}
            fill
            sizes="80px"
          />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 min-w-0">
            <h3 className="truncate text-xl font-bold text-foreground group-hover:text-muted-foreground transition-colors">
              {consultant.user.name}
            </h3>
            {consultant.isVerified && (
              <span title="Verified by Familiarise" className="shrink-0">
                <BadgeCheck className="w-5 h-5 text-foreground" />
              </span>
            )}
            {consultant.organizationBadge && (
              <Link
                href={`/explore/enterprise/organisations/${consultant.organizationBadge.slug}`}
                title={consultant.organizationBadge.name}
                onClick={(e) => e.stopPropagation()}
                className="relative z-10 min-w-0"
              >
                <Badge
                  variant="outline"
                  className="max-w-[180px] whitespace-nowrap border-border text-foreground text-[10px] px-1.5 py-0 hover:bg-muted transition-colors"
                >
                  <Building2 className="w-3 h-3 mr-0.5 shrink-0" />
                  <span className="truncate">
                    {consultant.organizationBadge.name}
                  </span>
                </Badge>
              </Link>
            )}
          </div>
          {isMeaningfulText(consultant.headline) && (
            <p className="mt-1 truncate text-sm font-medium text-muted-foreground">
              {consultant.headline.trim()}
            </p>
          )}
          <div className="flex items-center gap-2 mt-2">
            {consultant.rating !== null ? (
              <>
                <div className="flex items-center gap-1">
                  <Star className="w-4 h-4 text-amber-400 fill-amber-400" />
                  <span className="font-semibold text-foreground">
                    {consultant.rating.toFixed(1)}
                  </span>
                </div>
                <span className="text-muted-foreground/70">•</span>
              </>
            ) : null}
            <span className="text-sm text-muted-foreground">
              {reviewTotal} reviews
            </span>
          </div>
        </div>
      </div>

      {/* Description — only render when it's meaningful free-form text */}
      {isMeaningfulText(consultant.description) && (
        <p className="text-muted-foreground leading-relaxed mb-5 line-clamp-2">
          {consultant.description.trim()}
        </p>
      )}

      {/* Metadata Pills / Chips */}
      <div className="flex flex-wrap items-center gap-2 mb-5">
        {isMeaningfulText(consultant.headline) && (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/50 px-3 py-1 text-xs font-medium text-foreground">
            <Briefcase className="w-3.5 h-3.5 text-muted-foreground" />
            <span className="truncate max-w-[240px]">
              {consultant.headline.trim()}
            </span>
          </span>
        )}
        {consultant.experience !== null &&
          consultant.experience !== undefined && (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/50 px-3 py-1 text-xs font-medium text-foreground">
              <Clock className="w-3.5 h-3.5 text-muted-foreground" />
              {consultant.experience} yrs exp
            </span>
          )}
        {consultant.languages && consultant.languages.length > 0 && (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/50 px-3 py-1 text-xs font-medium text-foreground">
            <Globe className="w-3.5 h-3.5 text-muted-foreground" />
            {consultant.languages.join(", ")}
          </span>
        )}
      </div>

      {/* Company Logos */}
      {workExperiences.length > 0 && (
        <div className="flex items-center gap-2 mb-4">
          {workExperiences.slice(0, 3).map((exp) => (
            <CompanyLogo
              key={`${consultant.id}-company-${exp.company}`}
              companyName={exp.company}
              companyDomain={exp.companyDomain ?? undefined}
              size={36}
              className="border-border"
            />
          ))}
          <span className="text-sm text-muted-foreground ml-1">
            {workExperiences[0].company}
            {workExperiences.length > 1 && ` +${workExperiences.length - 1}`}
          </span>
        </div>
      )}

      {/* Domain, Subdomains & Skills Chips */}
      {hasTaxonomy && (
        <div className="flex flex-wrap gap-2">
          {consultant.domain?.name && (
            <Badge className="bg-primary text-primary-foreground hover:bg-primary/90 px-3 py-1">
              {consultant.domain.name}
            </Badge>
          )}
          {consultant.subDomains.slice(0, 2).map((sd) => (
            <Badge
              key={`${consultant.id}-subdomain-${sd.id}`}
              variant="outline"
              className="border-border text-muted-foreground px-3 py-1"
            >
              {sd.name}
            </Badge>
          ))}
          {consultant.tags.slice(0, 3).map((t) => (
            <Badge
              key={`${consultant.id}-tag-${t.id}`}
              className="bg-muted text-muted-foreground hover:bg-muted/80 px-3 py-1"
            >
              {t.name}
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}

export const ConsultantCard = memo(function ConsultantCard({
  consultant,
  metadata: _metadata,
  onSelect,
}: Readonly<ConsultantCardProps>) {
  const { formatPrice } = useCurrency();
  const profileHref = `/explore/experts/${consultant.id}`;

  const sortedPlans =
    consultant.subscriptionPlans
      ?.slice()
      .sort((a, b) => a.durationInMonths - b.durationInMonths) || [];
  const sortedConsultations =
    consultant.consultationPlans?.slice().sort((a, b) => a.price - b.price) ||
    [];
  const sortedClasses =
    consultant.classPlans?.slice().sort((a, b) => a.price - b.price) || [];

  const trialPlans = sortedPlans.filter((plan) => plan.trialEnabled);
  const trialOffer =
    trialPlans.length > 0
      ? {
          priceInPaise: Math.min(
            ...trialPlans.map((plan) => plan.trialPriceInPaise ?? 0),
          ),
        }
      : null;

  const tabLabels = buildTabLabels(sortedPlans);
  const secondaryActionsCount =
    (onSelect ? 1 : 0) + (trialOffer ? 1 : 0) + 1;
  const secondaryGridClass = getSecondaryGridClass(secondaryActionsCount);

  return (
    <div className="bg-card rounded-2xl border border-border hover:border-border hover:shadow-xl transition-all duration-300 overflow-hidden group">
      <div className="p-6 md:p-8 lg:p-10 flex flex-col lg:flex-row gap-8 lg:gap-12">
        <ConsultantDetailsSummary
          consultant={consultant}
          onSelect={onSelect}
        />

        {/* Right Section: Subscription Plans / Starting Session & Actions */}
        <div className="flex-shrink-0 lg:w-[380px] xl:w-[420px] space-y-4">
          <div className="bg-muted rounded-xl p-4">
            <ConsultantOfferingsPanel
              consultantId={consultant.id}
              sortedPlans={sortedPlans}
              tabLabels={tabLabels}
              startingConsultation={sortedConsultations[0] ?? null}
              consultationCount={sortedConsultations.length}
              startingClass={sortedClasses[0] ?? null}
              profileHref={profileHref}
              formatPrice={formatPrice}
            />
          </div>

          {/* Bottom Action Row: View full profile + Quick view / Trial / Book */}
          <div className="flex flex-col gap-2">
            <Button
              asChild
              className="w-full h-12 bg-primary hover:bg-primary/90 text-primary-foreground font-medium rounded-xl transition-all"
            >
              <Link href={profileHref}>
                <span>View full profile</span>
                <ArrowRight className="w-4 h-4 ml-2" />
              </Link>
            </Button>
            <div className={`grid gap-2 ${secondaryGridClass}`}>
              {onSelect && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => onSelect(consultant)}
                  className="h-10 border-border hover:bg-muted text-muted-foreground hover:text-foreground rounded-xl text-sm font-medium"
                >
                  Quick view
                </Button>
              )}
              {trialOffer && (
                <Button
                  asChild
                  variant="outline"
                  className="h-10 border-border hover:bg-muted text-muted-foreground rounded-xl text-sm font-medium"
                >
                  <Link href={`${profileHref}?action=trial`}>
                    {trialOffer.priceInPaise > 0
                      ? `Trial · ${formatPrice(trialOffer.priceInPaise)}`
                      : "Free intro call"}
                  </Link>
                </Button>
              )}
              <Button
                asChild
                variant="outline"
                className="h-10 border-border hover:bg-muted text-muted-foreground rounded-xl text-sm font-medium"
              >
                <Link href={`${profileHref}?action=book`}>Book Session</Link>
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
});
