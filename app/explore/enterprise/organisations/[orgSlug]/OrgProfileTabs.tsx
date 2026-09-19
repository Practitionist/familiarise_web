"use client";

import { ArrowRight, BadgeCheck, Building2, Star, Users } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

export interface OrgTabExpert {
  id: string;
  name: string;
  image: string | null;
  headline: string | null;
  /** Published 1:1/group score or null when suppressed below threshold. */
  score: number | null;
  domain: string | null;
  isVerified: boolean;
}

export type OrgPlanType = "CONSULTATION" | "SUBSCRIPTION" | "WEBINAR" | "CLASS";

export interface OrgTabPlan {
  id: string;
  title: string;
  subtitle: string | null;
  description: string | null;
  /** Minor units (paise); already JSON-safe — converted server-side. */
  price: number;
  planType: OrgPlanType;
}

export interface OrgTabAbout {
  description: string | null;
  industry: string | null;
  sizeLabel: string | null;
  capabilityLabel: string;
  website: string | null;
}

// Plan family → its public detail page. The card links there and checkout is
// reached from it — never straight to payment from this surface.
const PLAN_DETAIL_PATH: Record<OrgPlanType, string> = {
  CONSULTATION: "consultations",
  SUBSCRIPTION: "subscriptions",
  WEBINAR: "webinars",
  CLASS: "classes",
};

function ExpertMiniCard({ expert }: { expert: OrgTabExpert }) {
  return (
    <Link
      href={`/explore/experts/${expert.id}`}
      className="flex items-center gap-3 p-4 bg-card rounded-xl border border-border hover:border-border hover:shadow-md transition-all group"
    >
      <div className="relative w-12 h-12 flex-shrink-0">
        <Image
          src={expert.image ?? "/placeholder-user.jpg"}
          alt={expert.name}
          fill
          className="rounded-xl object-cover"
        />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1">
          <p className="font-semibold text-sm text-foreground group-hover:text-muted-foreground truncate">
            {expert.name}
          </p>
          {expert.isVerified && (
            <BadgeCheck className="w-4 h-4 text-foreground flex-shrink-0" />
          )}
        </div>
        {expert.headline && (
          <p className="text-xs text-muted-foreground truncate">
            {expert.headline}
          </p>
        )}
        <div className="flex items-center gap-2 mt-0.5">
          {/* Suppressed below the publication threshold — say nothing rather
              than print a number one review could define. */}
          {expert.score !== null && (
            <div className="flex items-center gap-0.5">
              <Star className="w-3 h-3 text-amber-400 fill-amber-400" />
              <span className="text-xs font-medium text-muted-foreground">
                {expert.score.toFixed(1)}
              </span>
            </div>
          )}
          {expert.domain && (
            <span className="text-xs text-muted-foreground/70">
              {expert.domain}
            </span>
          )}
        </div>
      </div>
    </Link>
  );
}

function PlanMiniCard({ plan }: { plan: OrgTabPlan }) {
  return (
    <Link
      href={`/explore/programs/plans/${PLAN_DETAIL_PATH[plan.planType]}/${plan.id}`}
      className="block p-4 rounded-xl bg-card border border-border hover:border-border hover:shadow-md transition-all group"
    >
      <p className="text-sm font-semibold text-foreground mb-0.5 line-clamp-1">
        {plan.title}
      </p>
      {/* Prefer the authored one-liner; fall back to the long description. */}
      {(plan.subtitle || plan.description) && (
        <p className="text-xs text-muted-foreground line-clamp-2">
          {plan.subtitle || plan.description}
        </p>
      )}
      <div className="flex items-center justify-between mt-2">
        <Badge
          variant="outline"
          className="text-[10px] px-1.5 py-0 capitalize"
        >
          {plan.planType.toLowerCase()}
        </Badge>
        {plan.price > 0 && (
          <span className="text-xs font-semibold text-muted-foreground">
            ₹{(plan.price / 100).toLocaleString("en-IN")}
          </span>
        )}
      </div>
      <span className="mt-2 inline-flex items-center gap-1 text-[11px] font-medium text-foreground group-hover:text-muted-foreground">
        Book
        <ArrowRight className="w-3 h-3" />
      </span>
    </Link>
  );
}

interface OrgProfileTabsProps {
  orgName: string;
  experts: OrgTabExpert[];
  plans: OrgTabPlan[];
  about: OrgTabAbout;
  canHost: boolean;
}

/**
 * Tabbed org body: Experts | Programs | About. Previously experts and plans
 * shared a squeezed 2/3-vs-1/3 split that truncated headlines and buried the
 * programs in grey boxes. Tabs give each roster full width with real counts.
 */
export default function OrgProfileTabs({
  orgName,
  experts,
  plans,
  about,
  canHost,
}: OrgProfileTabsProps) {
  const defaultTab = experts.length > 0 ? "experts" : plans.length > 0 ? "programs" : "about";

  return (
    <Tabs defaultValue={defaultTab} className="w-full" id="org-catalog">
      <TabsList
        aria-label={`${orgName} catalog`}
        className="w-full justify-start mb-6 bg-card p-1 rounded-xl border border-border overflow-x-auto"
      >
        <TabsTrigger value="experts" className="flex-1 data-[state=active]:bg-primary data-[state=active]:text-primary-foreground rounded-lg text-sm font-medium">
          Experts ({experts.length})
        </TabsTrigger>
        <TabsTrigger value="programs" className="flex-1 data-[state=active]:bg-primary data-[state=active]:text-primary-foreground rounded-lg text-sm font-medium">
          Programs ({plans.length})
        </TabsTrigger>
        <TabsTrigger value="about" className="flex-1 data-[state=active]:bg-primary data-[state=active]:text-primary-foreground rounded-lg text-sm font-medium">
          About
        </TabsTrigger>
      </TabsList>

      <TabsContent value="experts">
        {experts.length > 0 ? (
          // Single column at every width: two-up truncated most headlines
          // mid-word ("Executive Coa…") — full width lets them read.
          <div className="grid grid-cols-1 gap-3">
            {experts.map((expert) => (
              <ExpertMiniCard key={expert.id} expert={expert} />
            ))}
          </div>
        ) : canHost ? (
          <div className="flex flex-col items-center justify-center py-16 text-center bg-card rounded-2xl border border-border">
            <Users className="w-10 h-10 text-muted-foreground/70 mb-3" />
            <p className="text-muted-foreground">
              No exclusive experts listed yet
            </p>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-16 text-center bg-card rounded-2xl border border-border">
            <Building2 className="w-10 h-10 text-muted-foreground/70 mb-3" />
            <p className="text-muted-foreground">
              {orgName} does not host exclusive experts
            </p>
          </div>
        )}
      </TabsContent>

      <TabsContent value="programs">
        {plans.length > 0 ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {plans.map((plan) => (
              <PlanMiniCard key={plan.id} plan={plan} />
            ))}
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-16 text-center bg-card rounded-2xl border border-border">
            <p className="text-muted-foreground">No programs listed yet</p>
          </div>
        )}
      </TabsContent>

      <TabsContent value="about">
        <div className="bg-card rounded-2xl border border-border p-6 space-y-4">
          {about.description && (
            <p className="text-muted-foreground leading-relaxed">
              {about.description}
            </p>
          )}
          <dl className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
            {about.industry && (
              <div>
                <dt className="text-muted-foreground/70 text-xs uppercase tracking-wide">
                  Industry
                </dt>
                <dd className="text-foreground font-medium">{about.industry}</dd>
              </div>
            )}
            {about.sizeLabel && (
              <div>
                <dt className="text-muted-foreground/70 text-xs uppercase tracking-wide">
                  Size
                </dt>
                <dd className="text-foreground font-medium">{about.sizeLabel}</dd>
              </div>
            )}
            <div>
              <dt className="text-muted-foreground/70 text-xs uppercase tracking-wide">
                Type
              </dt>
              <dd className="text-foreground font-medium">
                {about.capabilityLabel}
              </dd>
            </div>
            {about.website && (
              <div>
                <dt className="text-muted-foreground/70 text-xs uppercase tracking-wide">
                  Website
                </dt>
                <dd>
                  <a
                    href={about.website}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-foreground font-medium underline underline-offset-2 hover:text-muted-foreground"
                  >
                    {about.website.replace(/^https?:\/\//, "")}
                  </a>
                </dd>
              </div>
            )}
          </dl>
        </div>
      </TabsContent>
    </Tabs>
  );
}
