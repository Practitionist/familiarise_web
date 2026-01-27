"use client";

import { memo } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Domain, SubDomain, Tag } from "@prisma/client";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { TConsultantProfile } from "@/types/consultant";
import {
  Star,
  MapPin,
  Clock,
  Briefcase,
  ArrowRight,
  CheckCircle2,
} from "lucide-react";
import { formatCurrency } from "@/app/checkout/plans/math";

interface ConsultantCardProps {
  consultant: TConsultantProfile;
  metadata: {
    domains: Domain[];
    subdomains: SubDomain[];
    tags: Tag[];
  } | null;
}

const ConsultantInfo = ({
  icon: Icon,
  label,
  value,
}: {
  icon: React.ElementType;
  label: string;
  value: string | null;
}) => (
  <div className="flex items-center gap-2 text-sm">
    <Icon className="w-4 h-4 text-zinc-400" />
    <span className="text-zinc-500">{label}:</span>
    <span className="text-zinc-800 font-medium">
      {value || "Not specified"}
    </span>
  </div>
);

const SubscriptionPlanCard = ({ plan }: { plan: any }) => {
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
          {formatCurrency(plan.price / 100, plan.priceCurrency || "INR")}
        </div>
        <div className="text-xs sm:text-sm text-zinc-500 font-medium bg-zinc-100 px-2 sm:px-3 py-1 rounded-full whitespace-nowrap">
          {formatDuration(plan.durationInMonths)}
        </div>
      </div>
      <div className="space-y-2.5">
        <div className="flex items-center gap-2 text-sm">
          <CheckCircle2 className="w-4 h-4 text-emerald-500" />
          <span className="text-zinc-600">{plan.callsPerWeek} calls/week</span>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <CheckCircle2 className="w-4 h-4 text-emerald-500" />
          <span className="text-zinc-600 capitalize">
            {plan.emailSupport.toLowerCase()} email support
          </span>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <CheckCircle2 className="w-4 h-4 text-emerald-500" />
          <span className="text-zinc-600">
            {plan.totalSessions} sessions total
          </span>
        </div>
      </div>
    </div>
  );
};

export const ConsultantCard = memo(function ConsultantCard({
  consultant,
  metadata,
}: ConsultantCardProps) {
  const router = useRouter();

  const sortedPlans =
    consultant.subscriptionPlans
      ?.slice()
      .sort((a, b) => a.durationInMonths - b.durationInMonths) || [];

  return (
    <div className="bg-white rounded-2xl border border-zinc-200 hover:border-zinc-300 hover:shadow-xl transition-all duration-300 overflow-hidden group">
      <div className="p-6 md:p-8 lg:p-10 flex flex-col lg:flex-row gap-8 lg:gap-12">
        {/* Left Section: Consultant Info */}
        <div
          className="flex-grow cursor-pointer"
          onClick={() => router.push(`/explore/experts/${consultant.id}`)}
        >
          {/* Header */}
          <div className="flex items-start gap-4 mb-6">
            <div className="relative h-20 w-20 flex-shrink-0">
              <Image
                alt={`Portrait of ${consultant.user.name}`}
                className="rounded-2xl object-cover ring-2 ring-zinc-100"
                src={consultant.user.image || "/placeholder-user.jpg"}
                fill
              />
              {/* Online indicator */}
              <div className="absolute -bottom-1 -right-1 w-5 h-5 bg-emerald-500 rounded-full border-2 border-white" />
            </div>
            <div className="flex-1 min-w-0">
              <h3 className="text-xl font-bold text-zinc-900 group-hover:text-zinc-700 transition-colors">
                {consultant.user.name}
              </h3>
              {consultant.user.email && (
                <span className="text-sm text-zinc-500">
                  @{consultant.user.email.split("@")[0]}
                </span>
              )}
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

          {/* Description */}
          <p className="text-zinc-600 leading-relaxed mb-6 line-clamp-2">
            {consultant.description}
          </p>

          {/* Meta Info */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-6">
            <ConsultantInfo
              icon={Clock}
              label="Experience"
              value={consultant.experience ? `${consultant.experience}` : null}
            />
            <ConsultantInfo
              icon={Briefcase}
              label="Headline"
              value={consultant.headline}
            />
            <ConsultantInfo
              icon={MapPin}
              label="Domain"
              value={consultant.domain.name}
            />
          </div>

          {/* Tags */}
          <div className="flex flex-wrap gap-2">
            <Badge className="bg-zinc-900 text-white hover:bg-zinc-800 px-3 py-1">
              {consultant.domain.name}
            </Badge>
            {consultant.subDomains.slice(0, 2).map((sd) => (
              <Badge
                key={`${consultant.id}-subdomain-${sd.id}`}
                variant="outline"
                className="border-zinc-300 text-zinc-700 px-3 py-1"
              >
                {sd.name}
              </Badge>
            ))}
            {consultant.tags.slice(0, 3).map((t) => (
              <Badge
                key={`${consultant.id}-tag-${t.id}`}
                className="bg-zinc-100 text-zinc-600 hover:bg-zinc-200 px-3 py-1"
              >
                {t.name}
              </Badge>
            ))}
          </div>
        </div>

        {/* Right Section: Subscription Plans & Actions */}
        <div className="flex-shrink-0 lg:w-[380px] xl:w-[420px] space-y-4">
          <div className="bg-zinc-50 rounded-xl p-4">
            {sortedPlans.length > 0 ? (
              <Tabs
                defaultValue={sortedPlans[0].durationInMonths.toString()}
                className="w-full"
              >
                <TabsList className="w-full mb-4 bg-white p-1 rounded-lg border border-zinc-200">
                  {sortedPlans.map((plan) => (
                    <TabsTrigger
                      key={`${consultant.id}-tab-trigger-${plan.id}`}
                      value={plan.durationInMonths.toString()}
                      className="flex-1 data-[state=active]:bg-zinc-900 data-[state=active]:text-white rounded-md text-sm font-medium transition-all duration-200"
                    >
                      {plan.durationInMonths}{" "}
                      {plan.durationInMonths === 1 ? "Mo" : "Mo"}
                    </TabsTrigger>
                  ))}
                </TabsList>
                {sortedPlans.map((plan) => (
                  <TabsContent
                    key={`${consultant.id}-tab-content-${plan.id}`}
                    value={plan.durationInMonths.toString()}
                  >
                    <SubscriptionPlanCard plan={plan} />
                  </TabsContent>
                ))}
              </Tabs>
            ) : (
              <div className="text-center text-zinc-500 py-8">
                <p className="text-sm">No subscription plans available</p>
              </div>
            )}
          </div>

          {/* Action Buttons */}
          <div className="flex flex-col gap-2">
            <Button
              className="w-full h-12 bg-zinc-900 hover:bg-zinc-800 text-white font-medium rounded-xl transition-all"
              onClick={() => router.push(`/explore/experts/${consultant.id}`)}
            >
              <span>View Profile</span>
              <ArrowRight className="w-4 h-4 ml-2" />
            </Button>
            <div className="grid grid-cols-2 gap-2">
              <Button
                variant="outline"
                className="h-10 border-zinc-300 hover:bg-zinc-50 text-zinc-700 rounded-xl text-sm font-medium"
              >
                Free Trial
              </Button>
              <Button
                variant="outline"
                className="h-10 border-zinc-300 hover:bg-zinc-50 text-zinc-700 rounded-xl text-sm font-medium"
              >
                Book Session
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
});
