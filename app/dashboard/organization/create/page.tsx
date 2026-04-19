"use client";

import React, { useState } from "react";
import Link from "next/link";
import { Check, X } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/utils/tailwind";

import { getSteps } from "./types";
import type { OrgWizardData } from "./types";
import { OrgInfoStep } from "./components/OrgInfoStep";
import { BillingStep } from "./components/BillingStep";
import { RevenueRatesStep } from "./components/RevenueRatesStep";
import { BrandingStep } from "./components/BrandingStep";
import { InviteTeamStep } from "./components/InviteTeamStep";
import { ReviewStep } from "./components/ReviewStep";

export default function CreateOrganizationWizard() {
  const [step, setStep] = useState(0);
  const [wizardData, setWizardData] = useState<Partial<OrgWizardData>>({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // Steps are recomputed whenever capabilities change (after step 0 submits).
  // An org with `canSponsor=false, canHost=false` is a configuration error;
  // OrgInfoStep rejects it before `handleNext` fires.
  const steps = getSteps({
    canSponsor: wizardData.canSponsor ?? true,
    canHost: wizardData.canHost ?? false,
  });

  const handleNext = async (stepData: Partial<OrgWizardData>) => {
    const merged = { ...wizardData, ...stepData };
    setWizardData(merged);

    const currentKey = steps[step].key;

    // Step 0: create the org on "Next" so we have an orgId for file uploads.
    // The initial POST carries just enough to satisfy the API's zod schema;
    // everything else is PATCHed step-by-step as the user moves forward.
    // That keeps each network call small and lets the review step do one
    // final consolidated PATCH.
    if (currentKey === "org-info" && !merged.orgId) {
      setIsSubmitting(true);
      setCreateError(null);
      try {
        const res = await fetch("/api/organizations", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: merged.name,
            billingEmail: merged.billingEmail,
            canSponsor: merged.canSponsor ?? true,
            canHost: merged.canHost ?? false,
            // Funding source is only required when the org sponsors.
            // Default = PERSONAL keeps the first POST successful even if
            // the user hasn't reached the billing step yet.
            ...(merged.canSponsor !== false
              ? { fundingSource: merged.fundingSource ?? "PERSONAL" }
              : {}),
            description: merged.description || undefined,
            industry: merged.industry || undefined,
            sizeBucket: merged.sizeBucket || undefined,
            website: merged.website || undefined,
          }),
        });
        const body = await res.json();
        if (!res.ok) {
          throw new Error(body.error || "Failed to create organization");
        }
        setWizardData((prev) => ({
          ...prev,
          ...stepData,
          orgId: body.organization.id,
        }));
      } catch (err) {
        setCreateError(
          err instanceof Error ? err.message : "Failed to create organization",
        );
        setIsSubmitting(false);
        return; // Don't advance
      }
      setIsSubmitting(false);
    }

    // Billing step: PATCH funding source when the org sponsors.
    if (currentKey === "billing" && merged.orgId) {
      await fetch(`/api/organizations/${merged.orgId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fundingSource: merged.fundingSource,
          paymentTermsDays: merged.paymentTermsDays,
        }),
      }).catch(() => null); // Non-blocking — review step will re-patch
    }

    // Revenue rates step: PATCH the bps split when the org hosts. Stored
    // as a new RateCard with `effectiveFrom=now()` so that subsequent
    // rate bumps don't rewrite earnings already accrued against this card.
    if (currentKey === "revenue-rates" && merged.orgId) {
      await fetch(`/api/organizations/${merged.orgId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          platformBps: merged.platformBps,
          orgBps: merged.orgBps,
          consultantBps: merged.consultantBps,
        }),
      }).catch(() => null); // Non-blocking — review step will re-patch
    }

    setStep((s) => Math.min(s + 1, steps.length - 1));
  };

  const handleBack = () => setStep((s) => Math.max(s - 1, 0));
  const handleGoToStep = (target: number) => setStep(target);

  const stepProps = {
    onNext: handleNext,
    onBack: handleBack,
    onGoToStep: handleGoToStep,
    initialData: wizardData,
    isSubmitting,
  };

  const currentStep = steps[step];

  return (
    <div className="min-h-screen bg-zinc-50">
      {/* Header */}
      <header className="sticky top-0 z-40 bg-white/80 backdrop-blur-xl border-b border-zinc-200/50">
        <div className="container mx-auto px-4 py-4 flex items-center justify-between max-w-3xl">
          <Link
            href="/dashboard/organization"
            className="text-sm font-semibold text-zinc-900 hover:text-zinc-700"
          >
            Familiarise
          </Link>
          <div className="flex items-center gap-4">
            <span className="text-sm text-zinc-500">
              Step {step + 1} of {steps.length}
            </span>
            <Link
              href="/dashboard/organization"
              className="flex items-center gap-1 text-sm text-zinc-500 hover:text-zinc-900 transition-colors"
              title="Cancel setup"
            >
              <X className="w-4 h-4" />
              <span className="hidden sm:inline">Cancel</span>
            </Link>
          </div>
        </div>
      </header>

      {/* Main content */}
      <main className="container mx-auto px-4 py-8 max-w-3xl">
        {/* Stepper */}
        <div className="flex items-start justify-between mb-8">
          {steps.map((s, index) => (
            <React.Fragment key={s.key}>
              <div className="flex flex-col items-center">
                <div
                  className={cn(
                    "w-9 h-9 rounded-full flex items-center justify-center text-sm font-medium border-2 transition-all",
                    index < step &&
                      "bg-primary border-primary text-primary-foreground",
                    index === step &&
                      "bg-primary border-primary text-primary-foreground ring-4 ring-primary/20",
                    index > step &&
                      "border-muted-foreground/30 text-muted-foreground",
                  )}
                >
                  {index < step ? <Check className="w-4 h-4" /> : index + 1}
                </div>
                <span
                  className={cn(
                    "text-xs mt-1.5 text-center max-w-[80px] truncate",
                    index <= step
                      ? "text-primary font-medium"
                      : "text-muted-foreground",
                  )}
                >
                  {s.label}
                </span>
              </div>
              {index < steps.length - 1 && (
                <div
                  className={cn(
                    "flex-1 h-0.5 mx-2 mt-[18px] transition-colors",
                    index < step ? "bg-primary" : "bg-muted-foreground/20",
                  )}
                />
              )}
            </React.Fragment>
          ))}
        </div>

        {/* Form card */}
        <Card className="shadow-lg">
          <CardHeader className="text-center pb-2">
            <CardTitle className="text-2xl">{currentStep.label}</CardTitle>
            <p className="text-muted-foreground text-sm mt-1">
              {currentStep.subtitle}
            </p>
          </CardHeader>
          <CardContent className="pt-4 pb-8 px-6 sm:px-8">
            {createError && (
              <div className="mb-4 p-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700">
                {createError}
              </div>
            )}

            {currentStep.key === "org-info" && <OrgInfoStep {...stepProps} />}
            {currentStep.key === "billing" && <BillingStep {...stepProps} />}
            {currentStep.key === "revenue-rates" && (
              <RevenueRatesStep {...stepProps} />
            )}
            {currentStep.key === "branding" && <BrandingStep {...stepProps} />}
            {currentStep.key === "invite-team" && (
              <InviteTeamStep {...stepProps} />
            )}
            {currentStep.key === "review" && <ReviewStep {...stepProps} />}
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
