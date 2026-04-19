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
  MapPin,
  Clock,
  Briefcase,
  Globe,
  ArrowRight,
  CheckCircle2,
  BadgeCheck,
  Building2,
} from "lucide-react";
import { useCurrency } from "@/hooks/useCurrency";

interface ConsultantCardProps {
  consultant: IConsultantCardData;
  metadata: {
    domains: { id: string; name: string }[];
    subdomains: { id: string; name: string }[];
    tags: { id: string; name: string }[];
  } | null;
}

const ConsultantInfo = ({
  icon: Icon,
  label,
  value,
}: {
  icon: React.ElementType;
  label: string;
  value: string | null | undefined;
}) => (
  <div className="flex items-center gap-2 text-sm">
    <Icon className="w-4 h-4 text-zinc-400" />
    <span className="text-zinc-500">{label}:</span>
    <span className="text-zinc-800 font-medium">
      {value || "Not specified"}
    </span>
  </div>
);

interface SubscriptionPlanCardData {
  price: number;
  durationInMonths: number;
  callsPerWeek: number | null;
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

const SubscriptionPlanCard = ({
  plan,
  formatPrice,
}: {
  plan: SubscriptionPlanCardData;
  formatPrice: (amountINR: number) => string;
}) => {
  const formatDuration = (months: number) => {
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
  };

  return (
    <div className="bg-white rounded-xl p-5 border border-zinc-200">
      <div className="flex flex-wrap items-baseline justify-between gap-2 mb-4">
        <div className="text-2xl sm:text-3xl font-bold text-zinc-900">
          {formatPrice(plan.price)}
        </div>
        <div className="text-xs sm:text-sm text-zinc-500 font-medium bg-zinc-100 px-2 sm:px-3 py-1 rounded-full whitespace-nowrap">
          {formatDuration(plan.durationInMonths)}
        </div>
      </div>
      <div className="space-y-2.5">
        {plan.callsPerWeek !== null &&
          plan.callsPerWeek !== undefined &&
          plan.callsPerWeek > 0 && (
          <div className="flex items-center gap-2 text-sm">
            <CheckCircle2 className="w-4 h-4 text-emerald-500" />
            <span className="text-zinc-600">
              {plan.callsPerWeek} {plan.callsPerWeek === 1 ? "call" : "calls"}/week
            </span>
          </div>
        )}
        {plan.emailSupport && (
          <div className="flex items-center gap-2 text-sm">
            <CheckCircle2 className="w-4 h-4 text-emerald-500" />
            <span className="text-zinc-600 capitalize">
              {plan.emailSupport.toLowerCase()} email support
            </span>
          </div>
        )}
        {plan.totalSessions !== null &&
          plan.totalSessions !== undefined &&
          plan.totalSessions > 0 && (
          <div className="flex items-center gap-2 text-sm">
            <CheckCircle2 className="w-4 h-4 text-emerald-500" />
            <span className="text-zinc-600">
              {plan.totalSessions}{" "}
              {plan.totalSessions === 1 ? "session" : "sessions"} total
            </span>
          </div>
        )}
      </div>
    </div>
  );
};

export const ConsultantCard = memo(function ConsultantCard({
  consultant,
  metadata: _metadata,
}: ConsultantCardProps) {
  const { formatPrice } = useCurrency();
  const profileHref = `/explore/experts/${consultant.id}`;

  const sortedPlans =
    consultant.subscriptionPlans
      ?.slice()
      .sort((a, b) => a.durationInMonths - b.durationInMonths) || [];

  // Count how many plans share each duration so we can disambiguate labels
  // when multiple plans have the same `durationInMonths`.
  const durationCounts = sortedPlans.reduce<Record<number, number>>(
    (acc, plan) => {
      acc[plan.durationInMonths] = (acc[plan.durationInMonths] || 0) + 1;
      return acc;
    },
    {},
  );
  const durationSeen: Record<number, number> = {};
  const tabLabels = sortedPlans.map((plan) => {
    const base = `${plan.durationInMonths} Mo`;
    if (durationCounts[plan.durationInMonths] > 1) {
      durationSeen[plan.durationInMonths] =
        (durationSeen[plan.durationInMonths] || 0) + 1;
      return `${base} (${durationSeen[plan.durationInMonths]})`;
    }
    return base;
  });

  return (
    <div className="bg-white rounded-2xl border border-zinc-200 hover:border-zinc-300 hover:shadow-xl transition-all duration-300 overflow-hidden group">
      <div className="p-6 md:p-8 lg:p-10 flex flex-col lg:flex-row gap-8 lg:gap-12">
        {/* Left Section: Consultant Info — real <Link> so right-click /
            cmd-click / middle-click open in a new tab. */}
        <Link href={profileHref} className="flex-grow block">
          {/* Header */}
          <div className="flex items-start gap-4 mb-6">
            <div className="relative h-20 w-20 flex-shrink-0">
              <Image
                alt={`Portrait of ${consultant.user.name}`}
                className="rounded-2xl object-cover ring-2 ring-zinc-100"
                src={consultant.user.image || "/placeholder-user.jpg"}
                fill
              />
              {/* TODO: Add real presence indicator when online tracking is implemented */}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5">
                <h3 className="text-xl font-bold text-zinc-900 group-hover:text-zinc-700 transition-colors">
                  {consultant.user.name}
                </h3>
                {consultant.isVerified && (
                  <span title="Verified by Familiarise">
                    <BadgeCheck className="w-5 h-5 text-blue-500" />
                  </span>
                )}
                {consultant.organizationBadge && (
                  <Link
                    href={`/org/${consultant.organizationBadge.slug}`}
                    onClick={(e) => e.stopPropagation()}
                    title={consultant.organizationBadge.name}
                  >
                    <Badge
                      variant="outline"
                      className="border-indigo-200 text-indigo-700 text-[10px] px-1.5 py-0 hover:bg-indigo-50 transition-colors"
                    >
                      <Building2 className="w-3 h-3 mr-0.5" />
                      {consultant.organizationBadge.name}
                    </Badge>
                  </Link>
                )}
              </div>
              <div className="flex items-center gap-2 mt-2">
                <div className="flex items-center gap-1">
                  <Star className="w-4 h-4 text-amber-400 fill-amber-400" />
                  <span className="font-semibold text-zinc-900">
                    {consultant.rating.toFixed(1)}
                  </span>
                </div>
                <span className="text-zinc-300">•</span>
                <span className="text-sm text-zinc-500">
                  {consultant.reviews?.length || 0} reviews
                </span>
              </div>
            </div>
          </div>

          {/* Description — only render when it's meaningful free-form text */}
          {isMeaningfulText(consultant.description) && (
            <p className="text-zinc-600 leading-relaxed mb-6 line-clamp-2">
              {consultant.description.trim()}
            </p>
          )}

          {/* Meta Info */}
          <div className="space-y-3 mb-6">
            {/* Headline - first line */}
            <ConsultantInfo
              icon={Briefcase}
              label="Headline"
              value={consultant.headline}
            />
            {/* Experience and Domain - second line together */}
            <div className="flex items-center gap-6">
              <ConsultantInfo
                icon={Clock}
                label="Experience"
                value={
                  consultant.experience
                    ? `${consultant.experience} years`
                    : null
                }
              />
              <ConsultantInfo
                icon={MapPin}
                label="Domain"
                value={consultant.domain?.name}
              />
            </div>
            {/* Languages */}
            {consultant.languages && consultant.languages.length > 0 && (
              <ConsultantInfo
                icon={Globe}
                label="Languages"
                value={consultant.languages.join(", ")}
              />
            )}
          </div>

          {/* Company Logos */}
          {consultant.user.workExperiences &&
            consultant.user.workExperiences.length > 0 && (
              <div className="flex items-center gap-2 mb-4">
                {consultant.user.workExperiences.slice(0, 3).map((exp, i) => (
                  <CompanyLogo
                    key={`${consultant.id}-company-${i}`}
                    companyName={exp.company}
                    companyDomain={exp.companyDomain ?? undefined}
                    size={36}
                    className="border-zinc-200"
                  />
                ))}
                <span className="text-sm text-zinc-600 ml-1">
                  {consultant.user.workExperiences[0].company}
                  {consultant.user.workExperiences.length > 1 &&
                    ` +${consultant.user.workExperiences.length - 1}`}
                </span>
              </div>
            )}

          {/* Domain & Subdomains */}
          <div className="flex flex-wrap gap-2">
            {consultant.domain?.name && (
              <Badge className="bg-zinc-900 text-white hover:bg-zinc-800 px-3 py-1">
                {consultant.domain.name}
              </Badge>
            )}
            {consultant.subDomains.slice(0, 2).map((sd) => (
              <Badge
                key={`${consultant.id}-subdomain-${sd.id}`}
                variant="outline"
                className="border-zinc-300 text-zinc-700 px-3 py-1"
              >
                {sd.name}
              </Badge>
            ))}
          </div>

          {/* Tags */}
          {consultant.tags.length > 0 && (
            <div className="flex flex-wrap gap-2 mt-2">
              {consultant.tags.slice(0, 3).map((t) => (
                <Badge
                  key={`${consultant.id}-tag-${t.id}`}
                  className="bg-zinc-100 text-zinc-600 hover:bg-zinc-200 px-3 py-1"
                >
                  {t.name}
                </Badge>
              ))}
            </div>
          )}
        </Link>

        {/* Right Section: Subscription Plans & Actions */}
        <div className="flex-shrink-0 lg:w-[380px] xl:w-[420px] space-y-4">
          <div className="bg-zinc-50 rounded-xl p-4">
            {sortedPlans.length > 0 ? (
              <Tabs defaultValue={sortedPlans[0].id} className="w-full">
                <TabsList className="w-full mb-4 bg-white p-1 rounded-lg border border-zinc-200">
                  {sortedPlans.map((plan, index) => (
                    <TabsTrigger
                      key={`${consultant.id}-tab-trigger-${plan.id}`}
                      value={plan.id}
                      className="flex-1 data-[state=active]:bg-zinc-900 data-[state=active]:text-white rounded-md text-sm font-medium transition-all duration-200"
                    >
                      {tabLabels[index]}
                    </TabsTrigger>
                  ))}
                </TabsList>
                {sortedPlans.map((plan) => (
                  <TabsContent
                    key={`${consultant.id}-tab-content-${plan.id}`}
                    value={plan.id}
                  >
                    <SubscriptionPlanCard
                      plan={plan}
                      formatPrice={formatPrice}
                    />
                  </TabsContent>
                ))}
              </Tabs>
            ) : (
              <div className="text-center text-zinc-500 py-8">
                <p className="text-sm">No subscription plans available</p>
              </div>
            )}
          </div>

          {/* Action Buttons — wrapped in <Link> via Button asChild so the
              browser context menu offers "Open in new tab" / "Copy link". */}
          <div className="flex flex-col gap-2">
            <Button
              asChild
              className="w-full h-12 bg-zinc-900 hover:bg-zinc-800 text-white font-medium rounded-xl transition-all"
            >
              <Link href={profileHref}>
                <span>View Profile</span>
                <ArrowRight className="w-4 h-4 ml-2" />
              </Link>
            </Button>
            <div className="grid grid-cols-2 gap-2">
              <Button
                asChild
                variant="outline"
                className="h-10 border-zinc-300 hover:bg-zinc-50 text-zinc-700 rounded-xl text-sm font-medium"
              >
                <Link href={`${profileHref}?action=trial`}>Free Trial</Link>
              </Button>
              <Button
                asChild
                variant="outline"
                className="h-10 border-zinc-300 hover:bg-zinc-50 text-zinc-700 rounded-xl text-sm font-medium"
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
