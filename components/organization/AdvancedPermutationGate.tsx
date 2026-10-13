"use client";

import { useState } from "react";
import { ChevronDown, ChevronUp, ShieldAlert, Sparkles } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";

import type { MotivationTier } from "./MotivationBanner";

export interface AdvancedPermutationGateProps {
  /** Whether the user has currently selected an advanced or discouraged option. */
  isActivePermutation?: boolean;
  /** Whether the currently selected permutation is Tier 3 DISCOURAGED (requires explicit acknowledgement). */
  isDiscouraged?: boolean;
  /** Optional motivation object from resolveProgramMotivation / getPermutationGuidance. */
  motivation?: {
    tier: MotivationTier;
    title?: string;
    message?: string;
    recommendation?: string;
  };
  /** Whether the gate starts expanded by default. */
  defaultExpanded?: boolean;
  /** Controlled acknowledgement state for Tier 3 discouraged selections. */
  acknowledged?: boolean;
  /** Callback when acknowledgement checkbox changes. */
  onAcknowledgeChange?: (checked: boolean) => void;
  /** Customized confirmation copy for Tier 3 selections. */
  discouragedConfirmationText?: string;
  /** Optional 1-click handler to reset back to the recommended Golden Path. */
  onSelectRecommended?: () => void;
  /** Alias for onSelectRecommended used by program dialogs. */
  onSelectGoldenPath?: () => void;
  recommendedActionLabel?: string;
  /** Summary label shown on the progressive-disclosure toggle button. */
  toggleLabel?: string;
  children: React.ReactNode;
}

/**
 * Progressive-disclosure gate for Tier 2 (Advanced) and Tier 3 (Discouraged)
 * enterprise configurations. Keeps advanced knobs reachable without cluttering
 * the default Golden Path, and requires an explicit friction acknowledgement
 * checkbox when an operator picks a Tier 3 high-friction option.
 */
export function AdvancedPermutationGate({
  isActivePermutation,
  isDiscouraged,
  motivation,
  defaultExpanded = false,
  acknowledged = false,
  onAcknowledgeChange,
  discouragedConfirmationText,
  onSelectRecommended,
  onSelectGoldenPath,
  recommendedActionLabel = "Use Recommended Golden Path Instead",
  toggleLabel = "Show Advanced & Non-Standard Permutations",
  children,
}: Readonly<AdvancedPermutationGateProps>) {
  const effectiveIsDiscouraged =
    isDiscouraged ?? motivation?.tier === "DISCOURAGED";
  const effectiveIsActive =
    isActivePermutation ??
    (motivation ? motivation.tier !== "RECOMMENDED" : false);
  const handleRecommended = onSelectRecommended ?? onSelectGoldenPath;
  const effectiveConfirmationText =
    discouragedConfirmationText ??
    (motivation?.message
      ? `I understand the operational and billing trade-offs of this configuration: ${motivation.message}`
      : "I understand that this configuration introduces additional billing, tax, or member checkout friction compared to the recommended Golden Path.");

  const [expanded, setExpanded] = useState(defaultExpanded);
  const isOpen = expanded || effectiveIsActive;

  return (
    <div className="space-y-3 rounded-lg border border-zinc-200 bg-zinc-50/60 p-3">
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => setExpanded((prev) => !prev)}
          className="flex items-center gap-1.5 text-xs font-medium text-zinc-700 hover:text-zinc-950"
        >
          {isOpen ? (
            <ChevronUp className="h-3.5 w-3.5 text-zinc-500" />
          ) : (
            <ChevronDown className="h-3.5 w-3.5 text-zinc-500" />
          )}
          <span>{toggleLabel}</span>
        </button>
        {effectiveIsActive && handleRecommended && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={handleRecommended}
            className="h-7 border-emerald-300 bg-emerald-50 text-xs text-emerald-900 hover:bg-emerald-100"
          >
            <Sparkles className="mr-1 h-3 w-3 text-emerald-600" />
            {recommendedActionLabel}
          </Button>
        )}
      </div>

      {isOpen && (
        <div className="space-y-3 border-t border-zinc-200/80 pt-3">
          {children}

          {effectiveIsDiscouraged && onAcknowledgeChange && (
            <div className="rounded-md border border-rose-300 bg-rose-50 p-3 space-y-2">
              <div className="flex items-center gap-1.5 text-xs font-semibold text-rose-900">
                <ShieldAlert className="h-4 w-4 text-rose-600 shrink-0" />
                <span>High-Friction Configuration Acknowledgement</span>
              </div>
              <label className="flex items-start gap-2.5 cursor-pointer">
                <Checkbox
                  checked={acknowledged}
                  onCheckedChange={(v) => onAcknowledgeChange(Boolean(v))}
                  className="mt-0.5"
                />
                <Label className="text-xs font-normal leading-relaxed text-rose-900 cursor-pointer">
                  {effectiveConfirmationText}
                </Label>
              </label>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
