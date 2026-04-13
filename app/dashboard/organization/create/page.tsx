"use client";

import React, { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Check, X } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/utils/tailwind";

import type { OrgWizardData } from "./types";
import { OrgInfoStep } from "./components/OrgInfoStep";
import { BillingStep } from "./components/BillingStep";
import { BrandingStep } from "./components/BrandingStep";
import { InviteTeamStep } from "./components/InviteTeamStep";
import { ReviewStep } from "./components/ReviewStep";

const STEP_LABELS = [
  "Org Info",
  "Billing & Seats",
  "Branding",
  "Invite Team",
  "Review",
];

const STEP_SUBTITLES = [
  "Tell us about your organization. You can always update this later.",
  "Choose how your learners will be billed for consultations.",
  "Customize your organization's visual identity.",
  "Invite your team members by email.",
  "Review everything and launch your organization.",
];

export default function CreateOrganizationWizard() {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [wizardData, setWizardData] = useState<Partial<OrgWizardData>>({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const handleNext = async (stepData: Partial<OrgWizardData>) => {
    const merged = { ...wizardData, ...stepData };
    setWizardData(merged);

    // Step 0: create the org on "Next" so we have an orgId for file uploads
    if (step === 0 && !merged.orgId) {
      setIsSubmitting(true);
      setCreateError(null);
      try {
        const res = await fetch("/api/organizations", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: merged.name,
            billingEmail: merged.billingEmail,
            kind: merged.kind || "BUYER",
            billingMode: merged.billingMode ?? "TAG_ONLY",
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
          orgProfileId: body.profile.id,
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

    // Step 1: PATCH billing settings
    if (step === 1 && merged.orgId) {
      await fetch(`/api/organizations/${merged.orgId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          billingMode: merged.billingMode,
          paymentTermsDays: merged.paymentTermsDays,
          seatsTotal: merged.seatsTotal,
        }),
      }).catch(() => null); // Non-blocking — review step will re-patch
    }

    setStep((s) => Math.min(s + 1, STEP_LABELS.length - 1));
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
              Step {step + 1} of {STEP_LABELS.length}
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
          {STEP_LABELS.map((label, index) => (
            <React.Fragment key={label}>
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
                  {label}
                </span>
              </div>
              {index < STEP_LABELS.length - 1 && (
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
            <CardTitle className="text-2xl">{STEP_LABELS[step]}</CardTitle>
            <p className="text-muted-foreground text-sm mt-1">
              {STEP_SUBTITLES[step]}
            </p>
          </CardHeader>
          <CardContent className="pt-4 pb-8 px-6 sm:px-8">
            {createError && (
              <div className="mb-4 p-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700">
                {createError}
              </div>
            )}

            {step === 0 && <OrgInfoStep {...stepProps} />}
            {step === 1 && <BillingStep {...stepProps} />}
            {step === 2 && <BrandingStep {...stepProps} />}
            {step === 3 && <InviteTeamStep {...stepProps} />}
            {step === 4 && <ReviewStep {...stepProps} />}
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
