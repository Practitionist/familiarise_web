"use client";

import Image from "next/image";
import Link from "next/link";
import {
  ArrowRight,
  BadgeCheck,
  Briefcase,
  Building2,
  Clock,
  Globe,
  Star,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { CompanyLogo } from "@/components/ui/company-logo";
import { useCurrency } from "@/hooks/useCurrency";
import type { IConsultantCardData } from "@/types/consultant";

interface ExpertDetailsSheetProps {
  consultant: IConsultantCardData | null;
  onClose: () => void;
}

/**
 * Right-side details drawer for the explore-experts listing.
 *
 * Adapts the Book Appointment prototype (list stays on the page, details fade
 * in from the side) onto the canonical `Sheet side="right"` primitive: Radix
 * drives slide-in-from-right + overlay fade, no vaul/framer-motion needed.
 * Content reuses the card's public fields (profile + plans + reviews summary)
 * with a sticky footer for View Profile / Trial / Book deep-links.
 */
export default function ExpertDetailsSheet({
  consultant,
  onClose,
}: Readonly<ExpertDetailsSheetProps>) {
  const { formatPrice } = useCurrency();
  const profileHref = consultant ? `/explore/experts/${consultant.id}` : "#";
  const plans = consultant?.subscriptionPlans ?? [];
  const cheapest = plans.length > 0 ? [...plans].sort((a, b) => a.price - b.price)[0] : null;
  // Cheapest trial across plans (mirrors ConsultantCard's trialOffer) — first
  // in array order is not the headline offer when plans are unsorted.
  const trialPlan =
    [...plans]
      .filter((p) => p.trialEnabled)
      .sort((a, b) => a.trialPriceInPaise - b.trialPriceInPaise)[0] ?? null;

  return (
    <Sheet open={!!consultant} onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        side="right"
        className="flex w-full flex-col overflow-hidden p-0 sm:max-w-lg lg:max-w-xl"
      >
        {consultant && (
          <>
            <SheetHeader className="border-b border-border p-6 pb-4 text-left">
              <div className="flex items-start gap-4 pr-8">
                <div className="relative h-16 w-16 shrink-0">
                  <Image
                    alt={`Portrait of ${consultant.user.name}`}
                    src={consultant.user.image || "/placeholder-user.jpg"}
                    fill
                    sizes="64px"
                    className="rounded-2xl object-cover ring-2 ring-muted"
                  />
                </div>
                <div className="min-w-0 flex-1">
                  <SheetTitle className="flex items-center gap-1.5 text-lg">
                    <span className="truncate">{consultant.user.name}</span>
                    {consultant.isVerified && (
                      <BadgeCheck
                        className="h-5 w-5 shrink-0 text-foreground"
                        aria-label="Verified by Familiarise"
                      />
                    )}
                  </SheetTitle>
                  <SheetDescription className="mt-1 line-clamp-2">
                    {consultant.headline || consultant.description || "Expert"}
                  </SheetDescription>
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
                    {consultant.rating !== null ? (
                      <span className="inline-flex items-center gap-1 font-semibold text-foreground">
                        <Star className="h-4 w-4 fill-amber-400 text-amber-400" />
                        {consultant.rating.toFixed(1)}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">New expert</span>
                    )}
                    <span className="text-muted-foreground">
                      {consultant.reviewCount ?? consultant.reviews?.length ?? 0} reviews
                    </span>
                    {consultant.organizationBadge && (
                      <Link
                        href={`/explore/enterprise/organisations/${consultant.organizationBadge.slug}`}
                        className="min-w-0"
                      >
                        <Badge
                          variant="outline"
                          className="max-w-[200px] whitespace-nowrap text-[10px]"
                        >
                          <Building2 className="mr-0.5 h-3 w-3 shrink-0" />
                          <span className="truncate">
                            {consultant.organizationBadge.name}
                          </span>
                        </Badge>
                      </Link>
                    )}
                  </div>
                </div>
              </div>
            </SheetHeader>

            <div className="min-h-0 flex-1 overflow-y-auto p-6 pt-4">
              <dl className="space-y-3 text-sm">
                {consultant.experience !== null &&
                  consultant.experience !== undefined && (
                  <div className="flex items-center gap-2">
                    <Clock className="h-4 w-4 text-muted-foreground/70" />
                    <dt className="text-muted-foreground">Experience:</dt>
                    <dd className="font-medium text-foreground">
                      {consultant.experience} years
                    </dd>
                  </div>
                )}
                {consultant.languages && consultant.languages.length > 0 && (
                  <div className="flex items-center gap-2">
                    <Globe className="h-4 w-4 text-muted-foreground/70" />
                    <dt className="text-muted-foreground">Languages:</dt>
                    <dd className="font-medium text-foreground">
                      {consultant.languages.join(", ")}
                    </dd>
                  </div>
                )}
                {consultant.headline && (
                  <div className="flex items-center gap-2">
                    <Briefcase className="h-4 w-4 text-muted-foreground/70" />
                    <dt className="text-muted-foreground">Headline:</dt>
                    <dd className="font-medium text-foreground">
                      {consultant.headline}
                    </dd>
                  </div>
                )}
              </dl>

              {consultant.user.workExperiences &&
                consultant.user.workExperiences.length > 0 && (
                  <div className="mt-4 flex items-center gap-2">
                    {consultant.user.workExperiences.slice(0, 3).map((exp, i) => (
                      <CompanyLogo
                        key={`${consultant.id}-drawer-company-${i}`}
                        companyName={exp.company}
                        companyDomain={exp.companyDomain ?? undefined}
                        size={32}
                        className="border-border"
                      />
                    ))}
                    <span className="ml-1 text-sm text-muted-foreground">
                      {consultant.user.workExperiences[0].company}
                    </span>
                  </div>
                )}

              {(consultant.domain?.name || consultant.subDomains.length > 0) && (
                <div className="mt-4">
                  <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Field
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {consultant.domain?.name && (
                      <Badge className="bg-primary px-3 py-1 text-primary-foreground">
                        {consultant.domain.name}
                      </Badge>
                    )}
                    {consultant.subDomains.slice(0, 4).map((sd) => (
                      <Badge key={sd.id} variant="outline" className="px-3 py-1">
                        {sd.name}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}

              {consultant.tags.length > 0 && (
                <div className="mt-4">
                  <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Skills
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {consultant.tags.slice(0, 8).map((t) => (
                      <Badge
                        key={t.id}
                        className="bg-muted px-3 py-1 text-muted-foreground"
                      >
                        {t.name}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}

              {consultant.description && (
                <div className="mt-4">
                  <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    About
                  </p>
                  <p className="text-sm leading-relaxed text-muted-foreground">
                    {consultant.description}
                  </p>
                </div>
              )}

              <div className="mt-6 rounded-xl border border-border bg-muted p-4">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Starting from
                </p>
                {cheapest ? (
                  <p className="mt-1 text-2xl font-bold text-foreground">
                    {formatPrice(cheapest.price)}
                    <span className="ml-2 text-sm font-medium text-muted-foreground">
                      / {cheapest.durationInMonths} mo
                    </span>
                  </p>
                ) : (
                  <p className="mt-1 text-sm text-muted-foreground">
                    No subscription plans listed — see profile for 1:1 options.
                  </p>
                )}
                {trialPlan && (
                  <p className="mt-2 text-sm text-muted-foreground">
                    {trialPlan.trialPriceInPaise > 0
                      ? `Trial available · ${formatPrice(trialPlan.trialPriceInPaise)}`
                      : "Free intro call available"}
                  </p>
                )}
              </div>
            </div>

            <div className="space-y-2 border-t border-border bg-card p-4">
              <Button asChild className="h-12 w-full rounded-xl font-medium">
                <Link href={profileHref}>
                  <span>View full profile</span>
                  <ArrowRight className="ml-2 h-4 w-4" />
                </Link>
              </Button>
              <div
                className={`grid gap-2 ${trialPlan ? "grid-cols-2" : "grid-cols-1"}`}
              >
                {trialPlan && (
                  <Button
                    asChild
                    variant="outline"
                    className="h-10 rounded-xl text-sm"
                  >
                    <Link href={`${profileHref}?action=trial`}>
                      {trialPlan.trialPriceInPaise > 0
                        ? `Trial · ${formatPrice(trialPlan.trialPriceInPaise)}`
                        : "Free intro call"}
                    </Link>
                  </Button>
                )}
                <Button asChild variant="outline" className="h-10 rounded-xl text-sm">
                  <Link href={`${profileHref}?action=book`}>Book session</Link>
                </Button>
              </div>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
