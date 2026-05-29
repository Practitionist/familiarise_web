/**
 * #771 / #715 — overage calculator (review §10).
 *
 * Pure function: given a program's cap config + current cycle usage + the
 * booking price, compute the covered vs marginal (overage) split, apply the
 * per-cycle circuit breaker, and resolve `overageBehavior`
 * (BLOCK / CHARGE_MEMBER / CHARGE_ORG) into a decision.
 *
 * Money is paise; counts are engagements. No DB access — the caller loads the
 * program config + cycle usage, calls this, and (on PROCEED with marginal > 0)
 * persists an `OverageEvent` + the matching ledger postings; the cycle-close
 * cron later rolls CHARGE_ORG events into an `InvoiceLineItem`.
 *
 * Today #715 ships this as a no-op: the schema fields exist and `wasOverage`
 * is set, but nothing computes a charge. This function is that missing logic.
 */
import type { OverageBehavior, ProgramType } from "@prisma/client";

export interface OverageInput {
  programType: ProgramType; // LICENSED_SEAT | CREDIT_POOL
  bookingPricePaise: number;
  /** Engagements this booking consumes (1 for CONSULTATION; N for multi-session). */
  sessionsConsumed: number;
  overageBehavior: OverageBehavior;
  /** Per-cycle overage ceiling (circuit breaker); null = no ceiling. */
  maxOveragePerCyclePaise: number | null;
  /** Cumulative overage already charged this cycle (paise). */
  cycleOverageSoFarPaise: number;

  // LICENSED_SEAT inputs
  /** null = unlimited (LICENSE-funded contract). */
  coveredEngagementsPerCycle?: number | null;
  engagementsUsed?: number;
  /** Caps the marginal charge per overage engagement; null = uncapped. */
  priceCapPerEngagementPaise?: number | null;

  // CREDIT_POOL (money-meter, D4) inputs
  /** Cycle budget in paise (1 credit == ₹1 == 100 paise). */
  creditBudgetPaise?: number | null;
  consumedPaise?: number;
}

export type OverageDecision = "PROCEED" | "BLOCK";
export type OverageChargeTarget = "MEMBER" | "ORG" | null;

export interface OverageResult {
  coveredPaise: number;
  marginalPaise: number;
  decision: OverageDecision;
  chargeTo: OverageChargeTarget;
  reason: string;
}

/** Compute the overage outcome for one booking. Pure; no side effects. */
export function computeOverage(input: OverageInput): OverageResult {
  const price = Math.max(0, Math.floor(input.bookingPricePaise));

  // --- Step 1: coverage split → marginalPaise -----------------------------
  let coveredPaise = price;
  let marginalPaise = 0;

  if (input.programType === "CREDIT_POOL") {
    const budget = input.creditBudgetPaise ?? 0;
    const consumed = input.consumedPaise ?? 0;
    const remaining = Math.max(0, budget - consumed);
    coveredPaise = Math.min(price, remaining);
    marginalPaise = price - coveredPaise;
  } else {
    // LICENSED_SEAT
    const cap = input.coveredEngagementsPerCycle;
    if (cap === null || cap === undefined) {
      // Unlimited (LICENSE-funded): fully covered, no overage.
      coveredPaise = price;
      marginalPaise = 0;
    } else {
      const used = input.engagementsUsed ?? 0;
      const sessions = Math.max(1, Math.floor(input.sessionsConsumed));
      const remainingSeats = Math.max(0, cap - used);
      if (remainingSeats >= sessions) {
        coveredPaise = price;
        marginalPaise = 0;
      } else {
        const overageSessions = sessions - remainingSeats;
        const perSession = Math.floor(price / sessions);
        const rawMarginal = overageSessions * perSession;
        const perCap = input.priceCapPerEngagementPaise;
        // priceCap caps the marginal per overage engagement (an absorbed discount).
        const capped =
          perCap != null
            ? Math.min(rawMarginal, overageSessions * perCap)
            : rawMarginal;
        marginalPaise = Math.min(price, capped);
        coveredPaise = price - marginalPaise;
      }
    }
  }

  if (marginalPaise <= 0) {
    return {
      coveredPaise: price,
      marginalPaise: 0,
      decision: "PROCEED",
      chargeTo: null,
      reason: "within cap",
    };
  }

  // --- Step 2: per-cycle circuit breaker → hard BLOCK regardless of behavior
  if (
    input.maxOveragePerCyclePaise != null &&
    input.cycleOverageSoFarPaise + marginalPaise > input.maxOveragePerCyclePaise
  ) {
    return {
      coveredPaise,
      marginalPaise,
      decision: "BLOCK",
      chargeTo: null,
      reason: "per-cycle overage ceiling reached (circuit breaker)",
    };
  }

  // --- Step 3: behavior branch --------------------------------------------
  switch (input.overageBehavior) {
    case "BLOCK":
      return {
        coveredPaise,
        marginalPaise,
        decision: "BLOCK",
        chargeTo: null,
        reason: "cap exhausted, behavior=BLOCK",
      };
    case "CHARGE_MEMBER":
      return {
        coveredPaise,
        marginalPaise,
        decision: "PROCEED",
        chargeTo: "MEMBER",
        reason: "overage charged to member",
      };
    case "CHARGE_ORG":
      return {
        coveredPaise,
        marginalPaise,
        decision: "PROCEED",
        chargeTo: "ORG",
        reason: "overage charged to org invoice",
      };
    default:
      return {
        coveredPaise,
        marginalPaise,
        decision: "BLOCK",
        chargeTo: null,
        reason: "unknown overageBehavior — failing safe to BLOCK",
      };
  }
}
