"use client";

import { AlertTriangle, CheckCircle2, Info, Sparkles } from "lucide-react";
import type {
  FundingSource,
  OverageBehavior,
  ProgramType,
} from "@prisma/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { getPermutationGuidance } from "@/lib/enterprise/reachable-paths";

export type MotivationTier = "RECOMMENDED" | "ADVANCED" | "DISCOURAGED";

export interface MotivationBannerProps {
  tier: MotivationTier;
  title: string;
  message: string;
  recommendation?: string;
  actionLabel?: string;
  onAction?: () => void;
  compact?: boolean;
  className?: string;
}

const TIER_STYLES: Record<
  MotivationTier,
  {
    container: string;
    badge: string;
    badgeLabel: string;
    iconColor: string;
    titleColor: string;
    bodyColor: string;
    recBox: string;
  }
> = {
  RECOMMENDED: {
    container: "border-emerald-200 bg-emerald-50/90 text-emerald-950",
    badge: "border-emerald-300 bg-emerald-100 text-emerald-900",
    badgeLabel: "Recommended · Golden Path",
    iconColor: "text-emerald-600",
    titleColor: "text-emerald-950",
    bodyColor: "text-emerald-900",
    recBox: "border-emerald-200/80 bg-white/70 text-emerald-900",
  },
  ADVANCED: {
    container: "border-amber-200 bg-amber-50/90 text-amber-950",
    badge: "border-amber-300 bg-amber-100 text-amber-900",
    badgeLabel: "Advanced Permutation",
    iconColor: "text-amber-600",
    titleColor: "text-amber-950",
    bodyColor: "text-amber-900",
    recBox: "border-amber-200/80 bg-white/70 text-amber-900",
  },
  DISCOURAGED: {
    container: "border-rose-300 bg-rose-50/95 text-rose-950",
    badge: "border-rose-300 bg-rose-100 text-rose-900",
    badgeLabel: "High Friction · Discouraged",
    iconColor: "text-rose-600",
    titleColor: "text-rose-950",
    bodyColor: "text-rose-900",
    recBox: "border-rose-200 bg-white/85 text-rose-950",
  },
};

export function MotivationBanner({
  tier,
  title,
  message,
  recommendation,
  actionLabel,
  onAction,
  compact = false,
  className = "",
}: Readonly<MotivationBannerProps>) {
  const styles = TIER_STYLES[tier];
  const Icon =
    tier === "RECOMMENDED"
      ? CheckCircle2
      : tier === "ADVANCED"
        ? Info
        : AlertTriangle;

  return (
    <div
      role="status"
      data-motivation-tier={tier}
      className={`rounded-lg border ${styles.container} ${
        compact ? "p-3" : "p-4"
      } transition-colors ${className}`}
    >
      <div className="flex items-start gap-3">
        <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${styles.iconColor}`} />
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className={`text-sm font-semibold ${styles.titleColor}`}>
              {title}
            </span>
            <Badge
              variant="outline"
              className={`text-[11px] font-medium ${styles.badge}`}
            >
              {tier === "RECOMMENDED" && (
                <Sparkles className="mr-1 h-3 w-3 inline-block" />
              )}
              {styles.badgeLabel}
            </Badge>
          </div>
          <p className={`text-xs leading-relaxed ${styles.bodyColor}`}>
            {message}
          </p>
          {recommendation && (
            <div
              className={`mt-2 rounded-md border px-2.5 py-2 text-xs ${styles.recBox}`}
            >
              <span className="font-medium">Guidance: </span>
              {recommendation}
            </div>
          )}
          {actionLabel && onAction && (
            <div className="pt-1">
              <Button
                type="button"
                size="sm"
                variant={tier === "DISCOURAGED" ? "default" : "outline"}
                onClick={onAction}
                className="h-7 text-xs"
              >
                {actionLabel}
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Computes the 3-tier motivation guidance for a funding rail selection in
 * organization creation and billing surfaces.
 */
export function resolveFundingRailMotivation(
  fundingSource: FundingSource | null | undefined,
): Omit<MotivationBannerProps, "onAction" | "actionLabel"> & {
  recommendedFallback?: FundingSource;
} {
  switch (fundingSource) {
    case "WALLET":
      return {
        tier: "RECOMMENDED",
        title: "Prepaid Wallet — Zero-Friction Learner Checkout",
        message:
          "Members book sessions immediately without entering a personal card. Every debit is tracked in your organization's ledger with full B2B GST invoicing on top-ups.",
        recommendation:
          "Best for agile teams and credit-pool programs where you want instant activation and strict prepaid spend control.",
      };
    case "INVOICE":
      return {
        tier: "RECOMMENDED",
        title: "Monthly B2B Invoice — Enterprise Procurement Standard",
        message:
          "Bookings accrue on your organization's receivables ledger and settle on a consolidated monthly GST tax invoice against your Purchase Order and Net payment terms.",
        recommendation:
          "Best for enterprise L&D cohorts using licensed seats or credit pools with centralized AP/procurement workflows.",
      };
    case "LICENSE":
      return {
        tier: "RECOMMENDED",
        title: "Enterprise License — Predictable Flat/Per-Seat Coverage",
        message:
          "Covers assigned seats under a contracted license subscription so learners book covered sessions at zero marginal checkout cost.",
        recommendation:
          "Pair with Licensed Seat programs and Block overage for 100% predictable periodic billing.",
      };
    case "PERSONAL":
      return {
        tier: "DISCOURAGED",
        title: "Personal Card + Reimbursement — High Employee Friction",
        message:
          "Employees must pay out of pocket with their personal credit/debit card or UPI at checkout and submit manual expense claims afterward. Consumer receipts cannot claim B2B GST Input Tax Credit (ITC), and learner adoption typically drops by 40–60%.",
        recommendation:
          "Switch to Prepaid Wallet or Monthly Invoice so your organization pays directly at checkout and receives compliant B2B GST invoices.",
        recommendedFallback: "WALLET",
      };
    default:
      return {
        tier: "RECOMMENDED",
        title: "Choose an Organization-Funded Rail",
        message:
          "Prepaid Wallet and Monthly B2B Invoice let learners book without personal card friction while preserving full B2B GST Input Tax Credit.",
      };
  }
}

/**
 * Computes the 3-tier motivation guidance for a program permutation
 * (FundingSource × ProgramType × OverageBehavior × Surcharge).
 */
export function resolveProgramMotivation(params: {
  fundingSource: FundingSource | null;
  programType: ProgramType | null;
  overageBehavior: OverageBehavior;
  overageSurchargeBps?: number | null;
}): Omit<MotivationBannerProps, "onAction" | "actionLabel"> & {
  recommendedPatch?: {
    programType?: "LICENSED_SEAT" | "CREDIT_POOL";
    overageBehavior?: OverageBehavior;
    overageSurchargeBps?: null;
  };
} {
  const guidance = getPermutationGuidance(params);

  let recommendedPatch:
    | {
        programType?: "LICENSED_SEAT" | "CREDIT_POOL";
        overageBehavior?: OverageBehavior;
        overageSurchargeBps?: null;
      }
    | undefined;

  switch (guidance.code) {
    case "WALLET_CHARGE_ORG_SURCHARGE":
    case "CHARGE_ORG_WITH_SURCHARGE":
      recommendedPatch = { overageSurchargeBps: null };
      break;
    case "LICENSE_CHARGE_ORG":
    case "PERSONAL_CHARGE_ORG":
      recommendedPatch = {
        overageBehavior: "BLOCK",
        overageSurchargeBps: null,
      };
      break;
    case "LICENSE_CREDIT_POOL":
      recommendedPatch = { programType: "LICENSED_SEAT" };
      break;
    case "SPLIT_TENDER_CHARGE_MEMBER":
      recommendedPatch = {
        overageBehavior:
          params.fundingSource === "INVOICE" ? "CHARGE_ORG" : "BLOCK",
        overageSurchargeBps: null,
      };
      break;
    default:
      recommendedPatch = undefined;
  }

  return {
    tier: guidance.tier,
    title: guidance.title,
    message: guidance.message,
    recommendation: guidance.recommendation,
    ...(recommendedPatch ? { recommendedPatch } : {}),
  };
}
