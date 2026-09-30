"use client";

import Link from "next/link";
import { ArrowUpRight, CheckCircle2 } from "lucide-react";
import type { ConsultantDetailData } from "../types";
import type { ExpertService } from "../offering-selection";

export function OfferingPreview({
  consultantDetails,
  service,
  planId,
}: {
  consultantDetails: ConsultantDetailData;
  service: ExpertService;
  planId: string;
}) {
  const consultation = service === "consultations";
  const plan = consultation
    ? consultantDetails.consultationPlans.find((item) => item.id === planId)
    : consultantDetails.subscriptionPlans.find((item) => item.id === planId);
  if (!plan) return null;
  const milestones =
    "subscriptionContents" in plan
      ? [...plan.subscriptionContents]
          .sort((a, b) => a.order - b.order)
          .slice(0, 3)
      : [];
  const outcomes = plan.learningOutcomes.slice(0, 3);
  const inclusions = plan.whatsIncluded.slice(0, 3);

  return (
    <section
      aria-labelledby="offering-preview-title"
      className="rounded-2xl border border-border bg-card p-6 md:p-8"
    >
      <p className="mb-2 text-xs font-medium uppercase tracking-widest text-muted-foreground">
        {consultation ? "Selected consultation" : "Selected mentorship"}
      </p>
      <h2
        id="offering-preview-title"
        className="text-2xl font-semibold tracking-tight"
      >
        {plan.title}
      </h2>
      {plan.subtitle && (
        <p className="mt-2 text-muted-foreground">{plan.subtitle}</p>
      )}
      {outcomes.length > 0 && (
        <div className="mt-6">
          <h3 className="text-sm font-semibold">What you’ll take away</h3>
          <ul className="mt-3 space-y-3 text-sm text-muted-foreground">
            {outcomes.map((outcome, index) => (
              <li key={index} className="flex gap-2">
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
                {outcome}
              </li>
            ))}
          </ul>
        </div>
      )}
      {milestones.length > 0 && (
        <div className="mt-6">
          <h3 className="text-sm font-semibold">A look at your curriculum</h3>
          <ol className="mt-4 space-y-4">
            {milestones.map((milestone, index) => (
              <li key={milestone.id} className="flex gap-3">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">
                  {index + 1}
                </span>
                <div>
                  <p className="text-sm font-medium">{milestone.title}</p>
                  {milestone.outcomes.length > 0 && (
                    <p className="mt-1 text-sm text-muted-foreground">
                      {milestone.outcomes[0]}
                    </p>
                  )}
                </div>
              </li>
            ))}
          </ol>
        </div>
      )}
      {inclusions.length > 0 && (
        <div className="mt-6">
          <h3 className="text-sm font-semibold">
            {consultation ? "Your session includes" : "Included in your plan"}
          </h3>
          <ul className="mt-3 space-y-2 text-sm text-muted-foreground">
            {inclusions.map((item, index) => (
              <li key={index}>{item}</li>
            ))}
          </ul>
        </div>
      )}
      {!outcomes.length && !milestones.length && !inclusions.length && (
        <p className="mt-4 text-sm text-muted-foreground">
          Explore the full plan for session information and booking details.
        </p>
      )}
      {!consultation && "totalSessions" in plan && (
        <p className="mt-6 border-t border-border pt-4 text-sm text-muted-foreground">
          Your plan includes {plan.totalSessions} sessions. Session dates are
          arranged with your expert after purchase.
        </p>
      )}
      <Link
        href={`/explore/programs/plans/${service}/${plan.id}`}
        className="mt-6 inline-flex items-center gap-2 text-sm font-medium underline-offset-4 hover:underline"
      >
        {consultation
          ? "View full session details"
          : "View full curriculum and plan"}
        <ArrowUpRight className="h-4 w-4" />
      </Link>
    </section>
  );
}
