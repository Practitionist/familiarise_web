"use client";

import Link from "next/link";
import type { PlanLevel } from "@prisma/client";
import {
  ArrowRight,
  BookOpen,
  CalendarDays,
  CheckCircle2,
  Clock,
  Globe,
  GraduationCap,
  Repeat,
  Sparkles,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PlanBrochureDownload } from "@/components/plans/PlanBrochureDownload";
import { useCurrency } from "@/hooks/useCurrency";
import { planLevelLabel } from "@/lib/labels/plan-labels";

export interface SnapshotConsultationPlan {
  id: string;
  title: string;
  subtitle?: string | null;
  description?: string | null;
  price: number;
  durationInHours: number;
  language?: string | null;
  level?: PlanLevel | null;
  learningOutcomes?: string[] | null;
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
  totalSessions?: number | null;
  language?: string | null;
  level?: PlanLevel | null;
  trialEnabled?: boolean | null;
  learningOutcomes?: string[] | null;
  whatsIncluded?: string[] | null;
}

export interface PlanDetailsSnapshotProps {
  consultationPlans: readonly SnapshotConsultationPlan[];
  subscriptionPlans: readonly SnapshotSubscriptionPlan[];
}

function getTopHighlights(
  learningOutcomes?: string[] | null,
  whatsIncluded?: string[] | null,
): string[] {
  const combined = [
    ...(learningOutcomes ?? []),
    ...(whatsIncluded ?? []),
  ].filter(Boolean);
  return Array.from(new Set(combined)).slice(0, 3);
}

function MetricPill({
  icon,
  label,
}: Readonly<{ icon: React.ReactNode; label: string }>) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/50 px-2.5 py-1 text-xs font-medium text-muted-foreground">
      {icon}
      {label}
    </span>
  );
}

function ConsultationPlanSnapshotCard({
  plan,
  formatPrice,
}: Readonly<{
  plan: SnapshotConsultationPlan;
  formatPrice: (price: number) => string;
}>) {
  const highlights = getTopHighlights(
    plan.learningOutcomes,
    plan.whatsIncluded,
  );
  const snippet = plan.subtitle || plan.description;
  const hoursLabel = `${plan.durationInHours} ${plan.durationInHours === 1 ? "hour" : "hours"}`;

  return (
    <div className="flex flex-col justify-between rounded-2xl border border-border/80 bg-background p-5 transition-colors hover:border-border">
      <div>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <Badge
              variant="secondary"
              className="mb-2 bg-muted text-muted-foreground"
            >
              1:1 Consultation
            </Badge>
            <h4 className="text-base font-semibold text-foreground">
              {plan.title}
            </h4>
          </div>
          <div className="text-right shrink-0">
            <p className="text-xl font-bold text-foreground">
              {formatPrice(plan.price)}
            </p>
            <p className="text-[11px] text-muted-foreground">/ session</p>
          </div>
        </div>

        {snippet && (
          <p className="mt-2 line-clamp-2 text-sm text-muted-foreground leading-relaxed">
            {snippet}
          </p>
        )}

        <div className="mt-3.5 flex flex-wrap items-center gap-1.5">
          <MetricPill
            icon={<Clock className="h-3.5 w-3.5" />}
            label={hoursLabel}
          />
          {plan.level && (
            <MetricPill
              icon={<GraduationCap className="h-3.5 w-3.5" />}
              label={planLevelLabel(plan.level)}
            />
          )}
          {plan.language && (
            <MetricPill
              icon={<Globe className="h-3.5 w-3.5" />}
              label={plan.language}
            />
          )}
        </div>

        {highlights.length > 0 && (
          <ul className="mt-4 space-y-1.5 border-t border-border/60 pt-3.5">
            {highlights.map((item) => (
              <li
                key={item}
                className="flex items-start gap-2 text-xs text-muted-foreground"
              >
                <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-500" />
                <span className="line-clamp-1">{item}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="mt-5 flex flex-wrap items-center justify-between gap-2.5 border-t border-border pt-4">
        <PlanBrochureDownload
          planId={plan.id}
          planType="consultations"
          label="Brochure (PDF)"
        />
        <Button asChild variant="ghost" size="sm" className="rounded-xl">
          <Link href={`/explore/programs/plans/consultations/${plan.id}`}>
            View Full Details
            <ArrowRight className="ml-1.5 h-3.5 w-3.5" />
          </Link>
        </Button>
      </div>
    </div>
  );
}

function SubscriptionPlanSnapshotCard({
  plan,
  formatPrice,
}: Readonly<{
  plan: SnapshotSubscriptionPlan;
  formatPrice: (price: number) => string;
}>) {
  const highlights = getTopHighlights(
    plan.learningOutcomes,
    plan.whatsIncluded,
  );
  const snippet = plan.subtitle || plan.description;
  const durationLabel = `${plan.durationInMonths} ${plan.durationInMonths === 1 ? "month" : "months"}`;

  return (
    <div className="flex flex-col justify-between rounded-2xl border border-border/80 bg-background p-5 transition-colors hover:border-border">
      <div>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="mb-2 flex flex-wrap items-center gap-1.5">
              <Badge
                variant="secondary"
                className="bg-muted text-muted-foreground"
              >
                Mentorship Programme
              </Badge>
              {plan.trialEnabled && (
                <Badge
                  variant="secondary"
                  className="gap-1 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                >
                  <Sparkles className="h-3 w-3" />
                  Trial available
                </Badge>
              )}
            </div>
            <h4 className="text-base font-semibold text-foreground">
              {plan.title}
            </h4>
          </div>
          <div className="text-right shrink-0">
            <p className="text-xl font-bold text-foreground">
              {formatPrice(plan.price)}
            </p>
            <p className="text-[11px] text-muted-foreground">
              / {durationLabel}
            </p>
          </div>
        </div>

        {snippet && (
          <p className="mt-2 line-clamp-2 text-sm text-muted-foreground leading-relaxed">
            {snippet}
          </p>
        )}

        <div className="mt-3.5 flex flex-wrap items-center gap-1.5">
          <MetricPill
            icon={<CalendarDays className="h-3.5 w-3.5" />}
            label={durationLabel}
          />
          {plan.sessionsPerWeek ? (
            <MetricPill
              icon={<Repeat className="h-3.5 w-3.5" />}
              label={`${plan.sessionsPerWeek} ${plan.sessionsPerWeek === 1 ? "session/week" : "sessions/week"}`}
            />
          ) : null}
          {plan.totalSessions ? (
            <MetricPill
              icon={<Clock className="h-3.5 w-3.5" />}
              label={`${plan.totalSessions} ${plan.totalSessions === 1 ? "session" : "sessions"} total`}
            />
          ) : null}
          {plan.level && (
            <MetricPill
              icon={<GraduationCap className="h-3.5 w-3.5" />}
              label={planLevelLabel(plan.level)}
            />
          )}
          {plan.language && (
            <MetricPill
              icon={<Globe className="h-3.5 w-3.5" />}
              label={plan.language}
            />
          )}
        </div>

        {highlights.length > 0 && (
          <ul className="mt-4 space-y-1.5 border-t border-border/60 pt-3.5">
            {highlights.map((item) => (
              <li
                key={item}
                className="flex items-start gap-2 text-xs text-muted-foreground"
              >
                <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-500" />
                <span className="line-clamp-1">{item}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="mt-5 flex flex-wrap items-center justify-between gap-2.5 border-t border-border pt-4">
        <PlanBrochureDownload
          planId={plan.id}
          planType="subscriptions"
          label="Brochure (PDF)"
        />
        <Button asChild variant="ghost" size="sm" className="rounded-xl">
          <Link href={`/explore/programs/plans/subscriptions/${plan.id}`}>
            View Full Details
            <ArrowRight className="ml-1.5 h-3.5 w-3.5" />
          </Link>
        </Button>
      </div>
    </div>
  );
}

export function PlanDetailsSnapshot({
  consultationPlans,
  subscriptionPlans,
}: Readonly<PlanDetailsSnapshotProps>) {
  const { formatPrice } = useCurrency();

  if (consultationPlans.length === 0 && subscriptionPlans.length === 0) {
    return null;
  }

  return (
    <section className="rounded-2xl border border-border bg-card p-6 md:p-8">
      <div className="mb-6 flex items-center gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-muted">
          <BookOpen className="h-5 w-5 text-muted-foreground" />
        </div>
        <div>
          <h3 className="text-lg font-semibold text-foreground">
            1:1 Consultations &amp; Mentorship Plans
          </h3>
          <p className="text-xs text-muted-foreground">
            Compare session formats, download plan brochures, or inspect full
            curriculum details
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {consultationPlans.map((plan) => (
          <ConsultationPlanSnapshotCard
            key={`consultation-${plan.id}`}
            plan={plan}
            formatPrice={formatPrice}
          />
        ))}
        {subscriptionPlans.map((plan) => (
          <SubscriptionPlanSnapshotCard
            key={`subscription-${plan.id}`}
            plan={plan}
            formatPrice={formatPrice}
          />
        ))}
      </div>
    </section>
  );
}
