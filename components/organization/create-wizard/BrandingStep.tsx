"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Building2 } from "lucide-react";
import type { StepProps } from "./types";
import {
  FUNDING_SOURCE_LABEL,
  narrowFundingSource,
} from "@/lib/labels/org-labels";

export function BrandingStep({
  onNext,
  onBack,
  initialData,
  isSubmitting,
}: StepProps) {
  const [primaryColor, setPrimaryColor] = useState(
    initialData.primaryColor ?? "#1a1a2e",
  );
  const [secondaryColor, setSecondaryColor] = useState(
    initialData.secondaryColor ?? "#16213e",
  );
  const [saveError, setSaveError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const handleSubmit = async () => {
    const orgId = initialData.orgId;

    // PATCH colors if an orgId exists. Logo + banner uploads land with
    // the live image-upload route (follow-up PR); the wizard stays
    // colors-only today. If the PATCH fails we surface it and stay on
    // this step — silently advancing would leave the wizard thinking
    // branding is saved when the server rejected it.
    if (orgId) {
      setSaveError(null);
      setIsSaving(true);
      try {
        const res = await fetch(`/api/organizations/${orgId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            primaryColor,
            secondaryColor,
          }),
        });
        if (!res.ok) {
          const message = await res
            .json()
            .then((b: { error?: string }) => b.error)
            .catch(() => null);
          setSaveError(
            message ??
              "Couldn't save branding. Please try again — your colors weren't applied.",
          );
          return;
        }
      } catch {
        setSaveError(
          "Couldn't reach the server. Check your connection and try again.",
        );
        return;
      } finally {
        setIsSaving(false);
      }
    }

    onNext({
      primaryColor,
      secondaryColor,
    });
  };

  // Narrow the funding-source enum via Zod so the preview uses the
  // user-facing label instead of the raw uppercase value.
  const fundingLabel = initialData.fundingSource
    ? FUNDING_SOURCE_LABEL[narrowFundingSource(initialData.fundingSource)]
    : FUNDING_SOURCE_LABEL.PERSONAL;

  return (
    <div className="space-y-6">
      {/* Colors */}
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="primaryColor">Primary color</Label>
          <div className="flex items-center gap-2">
            <input
              id="primaryColor"
              type="color"
              value={primaryColor}
              onChange={(e) => setPrimaryColor(e.target.value)}
              className="w-10 h-10 rounded border border-zinc-200 cursor-pointer"
            />
            <span className="text-sm text-zinc-500 font-mono">
              {primaryColor}
            </span>
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor="secondaryColor">Secondary color</Label>
          <div className="flex items-center gap-2">
            <input
              id="secondaryColor"
              type="color"
              value={secondaryColor}
              onChange={(e) => setSecondaryColor(e.target.value)}
              className="w-10 h-10 rounded border border-zinc-200 cursor-pointer"
            />
            <span className="text-sm text-zinc-500 font-mono">
              {secondaryColor}
            </span>
          </div>
        </div>
      </div>

      {/* Preview card */}
      <div className="rounded-xl border border-zinc-200 overflow-hidden">
        <div
          className="h-16"
          style={{ backgroundColor: primaryColor }}
        />
        <div className="p-4 flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-zinc-100 flex items-center justify-center overflow-hidden shrink-0">
            <Building2 className="w-5 h-5 text-zinc-400" />
          </div>
          <div>
            <p className="font-medium text-sm">
              {initialData.name || "Your Organization"}
            </p>
            <p
              className="text-xs"
              style={{ color: secondaryColor }}
            >
              {initialData.industry || "Industry"} &middot; {fundingLabel}
            </p>
          </div>
        </div>
      </div>

      {saveError && (
        <div
          role="alert"
          className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          {saveError}
        </div>
      )}

      <div className="flex justify-between pt-4">
        <Button type="button" variant="outline" onClick={onBack}>
          Back
        </Button>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="ghost"
            onClick={() => onNext({})}
          >
            Skip for now
          </Button>
          <Button
            type="button"
            onClick={handleSubmit}
            disabled={isSubmitting || isSaving}
          >
            {isSubmitting || isSaving ? "Saving…" : "Next"}
          </Button>
        </div>
      </div>
    </div>
  );
}
