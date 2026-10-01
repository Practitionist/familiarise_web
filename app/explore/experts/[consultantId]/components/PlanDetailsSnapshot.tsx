"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import type { PlanLevel } from "@prisma/client";
import {
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  CalendarDays,
  CheckCircle2,
  Clock,
  FileText,
  Globe,
  GraduationCap,
  Layers,
  MessageSquare,
  Repeat,
  Sparkles,
  Users,
  Video,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PlanBrochureDownload } from "@/components/plans/PlanBrochureDownload";
import { useCurrency } from "@/hooks/useCurrency";
import { planLevelLabel } from "@/lib/labels/plan-labels";
import { cn } from "@/utils/tailwind";

export interface SnapshotSubscriptionContentItem {
  id?: string;
  title: string;
  description?: string | null;
  order?: number;
  hoursAllotted?: number | null;
  hoursAllocated?: number | null;
  contentType?: string | null;
  sectionLabel?: string | null;
}

export interface SnapshotConsultationPlan {
  id: string;
  title: string;
  subtitle?: string | null;
  description?: string | null;
  price: number;
  durationInHours: number;
  language?: string | null;
  level?: PlanLevel | null;
  prerequisites?: string | null;
  materialProvided?: string | null;
  learningOutcomes?: string[] | null;
  targetAudience?: string[] | null;
  whatsIncluded?: string[] | null;
}

export interface SnapshotSubscriptionPlan {
  id: string;
  title: string;
  subtitle?: string | null;
  description?: string | null;
  price: number;
  durationInMonths: number;
  sessionsPerWeek?: number | null;
  sessionDurationInHours?: number | null;
  totalSessions?: number | null;
  totalHours?: number | null;
  emailSupport?: string | null;
  language?: string | null;
  level?: PlanLevel | null;
  prerequisites?: string | null;
  materialProvided?: string | null;
  trialEnabled?: boolean | null;
  learningOutcomes?: string[] | null;
  targetAudience?: string[] | null;
  whatsIncluded?: string[] | null;
  subscriptionContents?: readonly SnapshotSubscriptionContentItem[] | null;
}

export interface PlanDetailsSnapshotProps {
  consultationPlans: readonly SnapshotConsultationPlan[];
  subscriptionPlans: readonly SnapshotSubscriptionPlan[];
  activeServiceTab?: "consultations" | "subscriptions";
  onServiceTabChange?: (tab: "consultations" | "subscriptions") => void;
  selectedConsultationPlanId?: string;
  onSelectConsultationPlanId?: (planId: string) => void;
  selectedSubscriptionPlanId?: string;
  onSelectSubscriptionPlanId?: (planId: string) => void;
}

interface BentoMetricItem {
  icon: React.ReactNode;
  label: string;
  value: string;
}

function getDefaultConsultationInclusions(durationInHours: number): string[] {
  if (durationInHours >= 4) {
    return [
      "1:1 live video consultation",
      "Document & portfolio review",
      "Extended Q&A and action plan",
      "Priority follow-up support",
    ];
  }
  if (durationInHours >= 2) {
    return [
      "1:1 live video consultation",
      "Document & portfolio review",
      "Actionable next-step summary",
    ];
  }
  return ["1:1 live video consultation", "Personalized Q&A and guidance"];
}

function getDefaultSubscriptionInclusions(
  plan: SnapshotSubscriptionPlan,
): string[] {
  const items: string[] = [];
  if (plan.totalSessions) {
    items.push(`${plan.totalSessions} structured 1:1 mentorship sessions`);
  }
  if (plan.sessionsPerWeek) {
    items.push(
      `${plan.sessionsPerWeek} live call${plan.sessionsPerWeek > 1 ? "s" : ""} per week (${plan.sessionDurationInHours ?? 1}h each)`,
    );
  }
  if (plan.emailSupport) {
    items.push(`${plan.emailSupport.toLowerCase()} async support between calls`);
  }
  if (plan.materialProvided) {
    items.push(plan.materialProvided);
  }
  return items.length > 0
    ? items
    : ["Recurring 1:1 mentorship calls", "Personalized growth roadmap"];
}

function buildConsultationMetrics(
  plan: SnapshotConsultationPlan,
): BentoMetricItem[] {
  const hoursLabel = `${plan.durationInHours} ${plan.durationInHours === 1 ? "hour" : "hours"}`;
  return [
    {
      icon: <Clock className="h-4 w-4 text-muted-foreground" />,
      label: "Session Duration",
      value: hoursLabel,
    },
    {
      icon: <GraduationCap className="h-4 w-4 text-muted-foreground" />,
      label: "Experience Level",
      value: plan.level ? planLevelLabel(plan.level) : "All Levels",
    },
    {
      icon: <Globe className="h-4 w-4 text-muted-foreground" />,
      label: "Language",
      value: plan.language || "English",
    },
    {
      icon: <Video className="h-4 w-4 text-muted-foreground" />,
      label: "Format",
      value: "1:1 Live Video",
    },
  ];
}

function buildSubscriptionMetrics(
  plan: SnapshotSubscriptionPlan,
): BentoMetricItem[] {
  const durationLabel = `${plan.durationInMonths} ${plan.durationInMonths === 1 ? "month" : "months"}`;
  const callsPerWeek = plan.sessionsPerWeek ?? 1;
  const sessionHours = plan.sessionDurationInHours ?? 1;
  const totalSessions = plan.totalSessions ?? callsPerWeek * plan.durationInMonths * 4;
  const totalHours = plan.totalHours ?? totalSessions * sessionHours;
  const supportLabel = plan.emailSupport
    ? `${plan.emailSupport.charAt(0).toUpperCase()}${plan.emailSupport.slice(1).toLowerCase()}`
    : "Included";
  const levelLabel = plan.level ? planLevelLabel(plan.level) : "All Levels";

  return [
    {
      icon: <CalendarDays className="h-4 w-4 text-muted-foreground" />,
      label: "Program Duration",
      value: durationLabel,
    },
    {
      icon: <Repeat className="h-4 w-4 text-muted-foreground" />,
      label: "Weekly Cadence",
      value: `${callsPerWeek} calls/wk · ${sessionHours}h each`,
    },
    {
      icon: <Clock className="h-4 w-4 text-muted-foreground" />,
      label: "Total Coaching",
      value: `${totalSessions} sessions · ${totalHours}h total`,
    },
    {
      icon: <MessageSquare className="h-4 w-4 text-muted-foreground" />,
      label: "Async Support",
      value: `${supportLabel} · ${levelLabel}`,
    },
  ];
}

function SnapshotSwitcherBar({
  hasConsultations,
  hasSubscriptions,
  effectiveTab,
  consultationPlans,
  subscriptionPlans,
  selectedConsultationId,
  selectedSubscriptionId,
  onSelectTab,
  onSelectConsultation,
  onSelectSubscription,
}: Readonly<{
  hasConsultations: boolean;
  hasSubscriptions: boolean;
  effectiveTab: "consultations" | "subscriptions";
  consultationPlans: readonly SnapshotConsultationPlan[];
  subscriptionPlans: readonly SnapshotSubscriptionPlan[];
  selectedConsultationId: string;
  selectedSubscriptionId: string;
  onSelectTab: (tab: "consultations" | "subscriptions") => void;
  onSelectConsultation: (id: string) => void;
  onSelectSubscription: (id: string) => void;
}>) {
  const activePlans =
    effectiveTab === "consultations" ? consultationPlans : subscriptionPlans;
  const showServiceToggle = hasConsultations && hasSubscriptions;
  const showPlanPills = activePlans.length > 1;

  if (!showServiceToggle && !showPlanPills) {
    return null;
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      {showServiceToggle && (
        <div
          className="inline-flex items-center rounded-xl border border-border bg-muted p-1"
          role="tablist"
          aria-label="Plan category"
        >
          <button
            type="button"
            role="tab"
            aria-selected={effectiveTab === "consultations"}
            onClick={() => onSelectTab("consultations")}
            className={cn(
              "rounded-lg px-3 py-1.5 text-xs font-medium transition-colors",
              effectiveTab === "consultations"
                ? "bg-card text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            1:1 Consultation
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={effectiveTab === "subscriptions"}
            onClick={() => onSelectTab("subscriptions")}
            className={cn(
              "rounded-lg px-3 py-1.5 text-xs font-medium transition-colors",
              effectiveTab === "subscriptions"
                ? "bg-card text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            Mentorship Subscription
          </button>
        </div>
      )}

      {showPlanPills && (
        <div
          className="flex flex-wrap items-center gap-1.5"
          role="group"
          aria-label="Select plan option"
        >
          {effectiveTab === "consultations"
            ? consultationPlans.map((plan) => {
                const isSelected = plan.id === selectedConsultationId;
                return (
                  <button
                    key={plan.id}
                    type="button"
                    aria-pressed={isSelected}
                    onClick={() => onSelectConsultation(plan.id)}
                    className={cn(
                      "rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors",
                      isSelected
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border bg-background text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {plan.durationInHours}h · {plan.title}
                  </button>
                );
              })
            : subscriptionPlans.map((plan) => {
                const isSelected = plan.id === selectedSubscriptionId;
                return (
                  <button
                    key={plan.id}
                    type="button"
                    aria-pressed={isSelected}
                    onClick={() => onSelectSubscription(plan.id)}
                    className={cn(
                      "rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors",
                      isSelected
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border bg-background text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {plan.durationInMonths}m · {plan.title}
                  </button>
                );
              })}
        </div>
      )}
    </div>
  );
}

function SnapshotBentoStrip({
  metrics,
}: Readonly<{ metrics: readonly BentoMetricItem[] }>) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
      {metrics.map((metric) => (
        <div
          key={metric.label}
          className="rounded-xl border border-border/70 bg-muted/30 p-3.5"
        >
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            {metric.icon}
            <span>{metric.label}</span>
          </div>
          <p className="mt-1.5 text-sm font-semibold text-foreground">
            {metric.value}
          </p>
        </div>
      ))}
    </div>
  );
}

function SnapshotBulletColumns({
  learningOutcomes,
  whatsIncluded,
}: Readonly<{
  learningOutcomes: readonly string[];
  whatsIncluded: readonly string[];
}>) {
  if (learningOutcomes.length === 0 && whatsIncluded.length === 0) {
    return null;
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      <div className="rounded-xl border border-border/70 bg-muted/30 p-4">
        <h5 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
          Learning Outcomes
        </h5>
        {learningOutcomes.length > 0 ? (
          <ul className="space-y-2">
            {learningOutcomes.slice(0, 6).map((item) => (
              <li
                key={item}
                className="flex items-start gap-2 text-sm text-foreground"
              >
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
                <span>{item}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">
            Tailored to your goals and current skill level during the session.
          </p>
        )}
      </div>

      <div className="rounded-xl border border-border/70 bg-muted/30 p-4">
        <h5 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
          What&apos;s Included
        </h5>
        <ul className="space-y-2">
          {whatsIncluded.slice(0, 6).map((item) => (
            <li
              key={item}
              className="flex items-start gap-2 text-sm text-foreground"
            >
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
              <span>{item}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function SnapshotMetadataRow({
  targetAudience,
  prerequisites,
  materialProvided,
}: Readonly<{
  targetAudience?: readonly string[] | null;
  prerequisites?: string | null;
  materialProvided?: string | null;
}>) {
  const audienceList = (targetAudience ?? []).filter(Boolean);
  const hasAudience = audienceList.length > 0;
  const hasPrerequisites = Boolean(prerequisites?.trim());
  const hasMaterials = Boolean(materialProvided?.trim());

  if (!hasAudience && !hasPrerequisites && !hasMaterials) {
    return null;
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
      {hasAudience && (
        <div className="rounded-xl border border-border/70 bg-background p-4">
          <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
            <Users className="h-3.5 w-3.5" />
            <span>Who this is for</span>
          </div>
          <ul className="space-y-1 text-xs text-muted-foreground">
            {audienceList.slice(0, 4).map((item) => (
              <li key={item} className="truncate">
                • {item}
              </li>
            ))}
          </ul>
        </div>
      )}

      {hasPrerequisites && (
        <div className="rounded-xl border border-border/70 bg-background p-4">
          <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
            <Layers className="h-3.5 w-3.5" />
            <span>Prerequisites</span>
          </div>
          <p className="text-xs text-muted-foreground leading-relaxed">
            {prerequisites}
          </p>
        </div>
      )}

      {hasMaterials && (
        <div className="rounded-xl border border-border/70 bg-background p-4">
          <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
            <FileText className="h-3.5 w-3.5" />
            <span>Materials Provided</span>
          </div>
          <p className="text-xs text-muted-foreground leading-relaxed">
            {materialProvided}
          </p>
        </div>
      )}
    </div>
  );
}

function SnapshotRoadmapPreview({
  contents,
  detailHref,
}: Readonly<{
  contents?: readonly SnapshotSubscriptionContentItem[] | null;
  detailHref: string;
}>) {
  if (!contents || contents.length === 0) {
    return null;
  }

  const previewItems = contents.slice(0, 4);
  const remainingCount = contents.length - previewItems.length;

  return (
    <div className="rounded-xl border border-border/70 bg-muted/20 p-4 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h5 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Session Roadmap Preview ({contents.length} modules)
        </h5>
        {remainingCount > 0 && (
          <Link
            href={detailHref}
            className="text-xs font-medium text-foreground hover:underline"
          >
            +{remainingCount} more on full plan page →
          </Link>
        )}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
        {previewItems.map((item, idx) => {
          const sessionNumber = item.order ?? idx + 1;
          const hours = item.hoursAllotted ?? item.hoursAllocated;
          return (
            <div
              key={item.id ?? `${sessionNumber}-${item.title}`}
              className="rounded-lg border border-border/60 bg-background p-3"
            >
              <div className="flex items-center justify-between gap-2 text-[11px] font-medium text-muted-foreground">
                <span>Session {sessionNumber}</span>
                {hours ? <span>{hours}h</span> : null}
              </div>
              <p className="mt-1 text-sm font-semibold text-foreground line-clamp-1">
                {item.title}
              </p>
              {item.description && (
                <p className="mt-0.5 text-xs text-muted-foreground line-clamp-2">
                  {item.description}
                </p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function PlanDetailsSnapshot({
  consultationPlans,
  subscriptionPlans,
  activeServiceTab,
  onServiceTabChange,
  selectedConsultationPlanId,
  onSelectConsultationPlanId,
  selectedSubscriptionPlanId,
  onSelectSubscriptionPlanId,
}: Readonly<PlanDetailsSnapshotProps>) {
  const { formatPrice } = useCurrency();

  const sortedConsultations = useMemo(
    () =>
      [...consultationPlans].sort(
        (a, b) => a.durationInHours - b.durationInHours,
      ),
    [consultationPlans],
  );
  const sortedSubscriptions = useMemo(
    () =>
      [...subscriptionPlans].sort(
        (a, b) => a.durationInMonths - b.durationInMonths,
      ),
    [subscriptionPlans],
  );

  const hasConsultations = sortedConsultations.length > 0;
  const hasSubscriptions = sortedSubscriptions.length > 0;

  const [internalTab, setInternalTab] = useState<
    "consultations" | "subscriptions"
  >(hasConsultations ? "consultations" : "subscriptions");
  const [internalConsultationId, setInternalConsultationId] = useState<string>(
    sortedConsultations[0]?.id ?? "",
  );
  const [internalSubscriptionId, setInternalSubscriptionId] = useState<string>(
    sortedSubscriptions[0]?.id ?? "",
  );

  if (!hasConsultations && !hasSubscriptions) {
    return null;
  }

  const requestedTab = activeServiceTab ?? internalTab;
  const effectiveTab: "consultations" | "subscriptions" =
    requestedTab === "consultations" && hasConsultations
      ? "consultations"
      : requestedTab === "subscriptions" && hasSubscriptions
        ? "subscriptions"
        : hasConsultations
          ? "consultations"
          : "subscriptions";

  const activeConsultationId =
    selectedConsultationPlanId &&
    sortedConsultations.some((p) => p.id === selectedConsultationPlanId)
      ? selectedConsultationPlanId
      : sortedConsultations.some((p) => p.id === internalConsultationId)
        ? internalConsultationId
        : (sortedConsultations[0]?.id ?? "");

  const activeSubscriptionId =
    selectedSubscriptionPlanId &&
    sortedSubscriptions.some((p) => p.id === selectedSubscriptionPlanId)
      ? selectedSubscriptionPlanId
      : sortedSubscriptions.some((p) => p.id === internalSubscriptionId)
        ? internalSubscriptionId
        : (sortedSubscriptions[0]?.id ?? "");

  const handleSelectTab = (tab: "consultations" | "subscriptions") => {
    setInternalTab(tab);
    onServiceTabChange?.(tab);
  };

  const handleSelectConsultation = (id: string) => {
    setInternalConsultationId(id);
    onSelectConsultationPlanId?.(id);
  };

  const handleSelectSubscription = (id: string) => {
    setInternalSubscriptionId(id);
    onSelectSubscriptionPlanId?.(id);
  };

  const selectedConsultation =
    sortedConsultations.find((p) => p.id === activeConsultationId) ??
    sortedConsultations[0];
  const selectedSubscription =
    sortedSubscriptions.find((p) => p.id === activeSubscriptionId) ??
    sortedSubscriptions[0];

  const isConsultationActive =
    effectiveTab === "consultations" && Boolean(selectedConsultation);
  const activePlan = isConsultationActive
    ? selectedConsultation
    : selectedSubscription;

  if (!activePlan) {
    return null;
  }

  const detailHref = isConsultationActive
    ? `/explore/programs/plans/consultations/${activePlan.id}`
    : `/explore/programs/plans/subscriptions/${activePlan.id}`;
  const priceUnitLabel = isConsultationActive
    ? "per session"
    : `for ${selectedSubscription.durationInMonths} ${selectedSubscription.durationInMonths === 1 ? "month" : "months"}`;
  const metrics = isConsultationActive
    ? buildConsultationMetrics(selectedConsultation)
    : buildSubscriptionMetrics(selectedSubscription);
  const learningOutcomes = (activePlan.learningOutcomes ?? []).filter(Boolean);
  const rawIncluded = (activePlan.whatsIncluded ?? []).filter(Boolean);
  const whatsIncluded =
    rawIncluded.length > 0
      ? rawIncluded
      : isConsultationActive
        ? getDefaultConsultationInclusions(selectedConsultation.durationInHours)
        : getDefaultSubscriptionInclusions(selectedSubscription);
  const fullDescription = activePlan.description || activePlan.subtitle;

  return (
    <section className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-border bg-card">
            <BookOpen className="h-5 w-5 text-muted-foreground" />
          </div>
          <div>
            <h3 className="text-lg font-semibold text-foreground">
              Plan Details Snapshot
            </h3>
            <p className="text-xs text-muted-foreground">
              Medium-detail overview of your selected plan in the booking panel
            </p>
          </div>
        </div>

        <SnapshotSwitcherBar
          hasConsultations={hasConsultations}
          hasSubscriptions={hasSubscriptions}
          effectiveTab={effectiveTab}
          consultationPlans={sortedConsultations}
          subscriptionPlans={sortedSubscriptions}
          selectedConsultationId={activeConsultationId}
          selectedSubscriptionId={activeSubscriptionId}
          onSelectTab={handleSelectTab}
          onSelectConsultation={handleSelectConsultation}
          onSelectSubscription={handleSelectSubscription}
        />
      </div>

      {/* Single Elevated Plan Card */}
      <div className="rounded-2xl border border-border bg-card p-6 md:p-8 shadow-elevation-1 space-y-6">
        {/* Top Header Row */}
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="space-y-2 min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <Badge
                variant="secondary"
                className="bg-muted text-muted-foreground"
              >
                {isConsultationActive
                  ? "1:1 Consultation"
                  : "Mentorship Subscription"}
              </Badge>
              {!isConsultationActive && selectedSubscription.trialEnabled && (
                <Badge
                  variant="secondary"
                  className="gap-1 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                >
                  <Sparkles className="h-3 w-3" />
                  Free Trial Available
                </Badge>
              )}
            </div>
            <h4 className="text-xl md:text-2xl font-bold text-foreground">
              {activePlan.title}
            </h4>
            {activePlan.subtitle &&
              activePlan.subtitle !== activePlan.description && (
                <p className="text-sm font-medium text-muted-foreground">
                  {activePlan.subtitle}
                </p>
              )}
          </div>

          <div className="flex flex-col sm:flex-row lg:flex-col items-start sm:items-center lg:items-end justify-between gap-3 shrink-0">
            <div className=" lg:text-right">
              <span className="text-2xl md:text-3xl font-bold text-foreground">
                {formatPrice(activePlan.price)}
              </span>
              <span className="ml-1.5 text-xs text-muted-foreground">
                {priceUnitLabel}
              </span>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <PlanBrochureDownload
                planId={activePlan.id}
                planType={effectiveTab}
                label="Brochure (PDF)"
              />
              <Button asChild size="sm" className="h-10 rounded-xl px-4">
                <Link href={detailHref}>
                  View Full Plan Details
                  <ArrowUpRight className="ml-1.5 h-4 w-4" />
                </Link>
              </Button>
            </div>
          </div>
        </div>

        {/* Full Plan Description */}
        {fullDescription && (
          <p className="text-sm md:text-[15px] leading-relaxed text-muted-foreground">
            {fullDescription}
          </p>
        )}

        {/* Key Metrics Strip (4-column bento pills) */}
        <SnapshotBentoStrip metrics={metrics} />

        {/* Medium-Detail 2-Column Breakdown */}
        <SnapshotBulletColumns
          learningOutcomes={learningOutcomes}
          whatsIncluded={whatsIncluded}
        />

        {/* Audience, Prerequisites & Materials Row */}
        <SnapshotMetadataRow
          targetAudience={activePlan.targetAudience}
          prerequisites={activePlan.prerequisites}
          materialProvided={activePlan.materialProvided}
        />

        {/* Session Roadmap Preview (for Subscriptions) */}
        {!isConsultationActive && (
          <SnapshotRoadmapPreview
            contents={selectedSubscription.subscriptionContents}
            detailHref={detailHref}
          />
        )}

        {/* Bottom Redirect Footer Bar */}
        <div className="pt-4 border-t border-border/60 flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs sm:text-sm text-muted-foreground">
            Want the complete breakdown, FAQs, and full curriculum?
          </p>
          <Link
            href={detailHref}
            className="inline-flex items-center gap-1.5 text-sm font-semibold text-foreground hover:text-muted-foreground transition-colors"
          >
            <span>Go to Full Plan Details</span>
            <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
      </div>
    </section>
  );
}
