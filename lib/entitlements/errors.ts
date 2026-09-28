/**
 * Turning a plan gate into a `Refusal` the customer can act on.
 *
 * A refusal is not a failure, so it must never reach the client as a 500 or a
 * "Something went wrong". Both gates below answer the two questions a customer
 * actually has — *what did I not get* and *what now* — and both reuse the codes
 * `lib/labels/auth-errors.catalog.ts` already declares, so the sentence the
 * client renders is the sentence the server refused with.
 *
 * ## Codes are pinned, not redeclared
 *
 * `ENTITLEMENT_REFUSAL_CODES` is `satisfies Record<string, keyof typeof
 * AUTH_ERROR_COPY>`. If Better Auth's error surface ever drops or renames
 * either code, this stops compiling instead of emitting a refusal whose `code`
 * no client can branch on. That is the same guarantee the catalog gives itself
 * by being `Record<AuthErrorCode, AuthErrorCopy>`, pointed the other way.
 *
 * The catalog's `PLAN_FEATURE_NOT_INCLUDED` copy is deliberately generic
 * ("Upgrade your plan to unlock this") because it is keyed by code alone and
 * does not know which feature was refused. `requireEntitlement` therefore
 * *extends* the catalog sentence with the capability name rather than
 * replacing it, and `entitlementCopy()` hands the client the catalog entry so
 * the title and the `upgrade-plan` affordance stay in one place.
 *
 * ## Why 403 for the feature gate
 *
 * `docs/authorization/README.md` §7 reserves 404 for capability gates, where
 * the feature structurally does not exist for that org shape and the affordance
 * must be hidden. A plan entitlement is the opposite: the feature exists, is
 * visible on the pricing page, and the copy exists to tell the customer how to
 * reach it. Answering 404 would throw away the `upgrade-plan` affordance and
 * leave a 403-shaped problem wearing a not-found costume.
 *
 * ## Why 409 for the limit gate
 *
 * A limit is a statement about current state, not about permission: the plan
 * grants the capability, the cycle is simply full. `Refusal` itself defaults to
 * 409 (lib/errors/refusal.ts:36) for exactly this, and the catalog's own copy
 * for `PLAN_LIMIT_REACHED` says "or wait for the current cycle to reset" — a
 * transient, state-dependent answer. 403 would assert a permanent lack of
 * permission and invite the customer to pay for something they already own.
 */

import { Refusal } from "@/lib/errors/refusal";
import {
  AUTH_ERROR_COPY,
  type AuthErrorCopy,
} from "@/lib/labels/auth-errors.catalog";

import {
  b2cPlanLabel,
  describeEntitlement,
  hasEntitlement,
  PLAN_LIMIT_LABEL,
  planLimit,
  upgradePathFor,
  type B2CPlan,
  type Entitlement,
  type PlanLimit,
} from "./plan-entitlements";

/**
 * The two codes, pinned to the catalog. See the header for why this is a
 * compile-time assertion and not a `const` with a comment.
 */
export const ENTITLEMENT_REFUSAL_CODES = {
  featureNotIncluded: "PLAN_FEATURE_NOT_INCLUDED",
  limitReached: "PLAN_LIMIT_REACHED",
} as const satisfies Record<string, keyof typeof AUTH_ERROR_COPY>;

/**
 * The catalog copy behind a code, so a client handed only a `code` (the
 * `RefusalShape` on the wire carries no feature name) still renders the right
 * title, the right sentence and the `upgrade-plan` button.
 */
export function entitlementCopy(code: string): AuthErrorCopy | undefined {
  return (AUTH_ERROR_COPY as Record<string, AuthErrorCopy>)[code];
}

/**
 * The refusal for a missing capability, or `null` when the plan holds it — the
 * predicate form, for callers that guard a whole branch.
 */
export function entitlementRefusal(
  plan: B2CPlan,
  entitlement: Entitlement,
): Refusal | null {
  if (hasEntitlement(plan, entitlement)) return null;

  const feature = describeEntitlement(entitlement);
  const upgrade = upgradePathFor(plan, entitlement);
  const wayOut = upgrade
    ? `Upgrading to ${b2cPlanLabel(upgrade)} unlocks ${feature}.`
    : `Your ${b2cPlanLabel(plan)} plan doesn't include ${feature}.`;

  return new Refusal({
    code: ENTITLEMENT_REFUSAL_CODES.featureNotIncluded,
    httpStatus: 403,
    userMessage: wayOut,
    devMessage: `plan ${plan} lacks ${entitlement}`,
    context: { plan, entitlement, upgradeTo: upgrade },
  });
}

/**
 * The guard form: throws the refusal when the capability is missing, returns
 * normally when it is present. Throwing a `Refusal` is safe on the server —
 * `isRefusal` and `apiError` (lib/errors/index.ts) already recognise it — and
 * a server action that wants a value instead uses `refusalResult` on the result
 * of `entitlementRefusal`.
 */
export function requireEntitlement(
  plan: B2CPlan,
  entitlement: Entitlement,
): void {
  const refusal = entitlementRefusal(plan, entitlement);
  if (refusal) throw refusal;
}

/**
 * The refusal for a reached cap, or `null` while there is room.
 *
 * A `null` cap is unlimited, so it must be answered before the comparison
 * rather than coerced to a number — see `planLimit`.
 */
export function planLimitRefusal(
  plan: B2CPlan,
  key: PlanLimit,
  currentUsage: number,
): Refusal | null {
  const cap = planLimit(plan, key);
  if (cap === null || currentUsage < cap) return null;

  return new Refusal({
    code: ENTITLEMENT_REFUSAL_CODES.limitReached,
    // 409, not 403: see the header. The plan grants the capability and the
    // cycle is full.
    httpStatus: 409,
    userMessage: `You've used all ${cap} days of ${PLAN_LIMIT_LABEL[key]} on ${b2cPlanLabel(plan)}. Wait for the current cycle to reset, or upgrade your plan.`,
    devMessage: `plan ${plan} limit ${key} reached: ${currentUsage}/${cap}`,
    context: { plan, key, currentUsage, cap },
  });
}

/** The guard form of `planLimitRefusal`. See `requireEntitlement`. */
export function requirePlanLimit(
  plan: B2CPlan,
  key: PlanLimit,
  currentUsage: number,
): void {
  const refusal = planLimitRefusal(plan, key, currentUsage);
  if (refusal) throw refusal;
}
