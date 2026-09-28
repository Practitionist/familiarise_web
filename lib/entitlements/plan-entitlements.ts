/**
 * B2C plan entitlements — what a buyer's plan lets them reach.
 *
 * The repo has three working authorization matrices and none of them answers
 * this question. `UserRole` (platform), `MemberRole` (org, `lib/auth/
 * org-permissions.ts`) and `BackofficeSurface` (internal surfaces, `lib/auth/
 * backoffice-permissions.ts`) all answer "who is this user". None answers "what
 * has this customer paid for", and a customer has no plan column: `User` has
 * none and `ConsulteeProfile` (schema:3334) carries only careerStage,
 * budgetPreference, isIndependent and a GST code. So a paid capability could
 * only be enforced ad hoc — which is exactly what happened to permanent
 * recordings (see `recording.permanentStorage` below).
 *
 * ## Why the key is NOT `PlanLevel`
 *
 * `PlanLevel` (schema:6597) is BEGINNER / INTERMEDIATE / ADVANCED /
 * ALL_LEVELS, and it describes the *offering the expert authored*:
 *
 *   - it is an author-supplied column on all four plan models, defaulting to
 *     BEGINNER, set from the planner form (`schemas/plans.ts:197`,
 *     `components/offerings/editor/adapters.ts:35`);
 *   - its only reader is a catalogue facet — `app/explore/programs` filters
 *     and sorts browse results by it through `sortPlanLevels`;
 *   - it gates nothing, for anyone, anywhere in the codebase.
 *
 * Gating permanent recording storage on it would say: you may keep this
 * recording only if the plan you bought is tagged Beginner. A ₹500 beginner
 * course and a ₹50,000 beginner course are the same `PlanLevel`, and an
 * advanced course is not a *better* plan — it is a *harder* one. The seed
 * files make the shape obvious: `prisma/seedFiles/4b-create-subscription-
 * plans.ts` writes one BEGINNER, one INTERMEDIATE and one ADVANCED plan, each
 * a different course by a different expert, at three different prices.
 *
 * `lib/labels/plan-labels.ts` is the standing proof that this vocabulary is a
 * label table and nothing more, and it is deliberately not imported here: a
 * second `PlanLevel` ladder inside the entitlements folder is the exact drift
 * the three matrices were written to prevent.
 *
 * ## Why the ladder is declared here
 *
 * The B2C ladder has no persisted home yet, and adding one is a schema change
 * owned elsewhere. The four rungs below are the only plan names the codebase
 * already uses for a *purchased* subscription, and two independent places
 * agree on them:
 *
 *   - `getSubscriptionType()` (utils/subscriptionValidation.ts:566) derives
 *     Basic / Extended / Comprehensive / Custom from a subscription's
 *     `sessionsPerWeek` × `durationInMonths`;
 *   - `ClassPlanType` (utils/classPlans.ts:10) is the same four names.
 *
 * So `B2CPlan` is declared locally and closed, ordered cheapest-first with the
 * bespoke catch-all last — the same shape as `PLAN_LEVEL_ORDER` in the label
 * module, and for the same reason: a facet sorted alphabetically reads
 * "Comprehensive, Custom, Extended". The moment a `B2CPlan` enum lands in the
 * schema, swap the union for a type-only import and this file is otherwise
 * unchanged: every `Record` here is exhaustive over it, so the new rung is a
 * compile error until someone has decided what it grants.
 *
 * ## Purity
 *
 * No `next/server`, no Prisma runtime, no I/O, no clock. Route handlers and
 * client components import this file, and the client half is the one that
 * cannot take a server-only dependency.
 */

/**
 * A buyer's plan rung, cheapest first. See the header for why this is not
 * `PlanLevel` and what it will become.
 */
export type B2CPlan = "BASIC" | "EXTENDED" | "COMPREHENSIVE" | "CUSTOM";

/**
 * A B2C capability a plan can grant. Dotted like `OrgSurface` so a key reads
 * as the thing it reaches, and split per-action rather than per-resource for
 * the same reason the org matrix splits `recordings.read` from
 * `recordings.play`: "you may keep this" and "you may show it to the world"
 * are different promises.
 *
 * Every member below is tied to a column that already exists. A capability the
 * product does not implement is not a cheap entitlement to declare now and
 * enforce later — it is a word the refusal copy will confidently use to tell a
 * customer to upgrade for something they still cannot reach.
 */
export type Entitlement =
  /**
   * Keep a recording past the retention window instead of losing it.
   * `RecordingStoragePolicy` (schema:5256) is the whole story: STREAM_ONLY is
   * commented "2-week temporary storage (free tier)", PERMANENT is "kept in our
   * own bucket indefinitely (premium tier)". The schema comment is the only
   * place in the database where "free tier" and "premium tier" describe a
   * buyer-facing difference. `resolveAppointmentStoragePolicy`
   * (lib/stream/recording-listing-access.ts:113) reads it fail-closed —
   * unknown provenance never earns PERMANENT.
   */
  | "recording.permanentStorage"
  /**
   * Publish a recording onward. The publish route refuses anything not
   * permanently stored (app/api/stream/recordings/[recordingId]/publish/
   * route.ts:131, "Only permanently stored (premium plan) recordings can be
   * published"), so this is strictly stronger than the key above it.
   */
  | "recording.publish"
  /**
   * Record the session at all. `recordingEnabled` on the four plan models,
   * enforced by `isRecordingEnabledForAppointment` (lib/stream/recording-utils
   * .ts:81) through `lib/stream/recording-consent.ts:68`; #1134 P1-6 is the
   * 1:1 arm that used to 403 structurally because only webinar and class were
   * understood.
   */
  | "recording.capture"
  /**
   * An email answer on the support SLA rather than the general queue.
   * `PlanEmailSupport` (schema:6604) carries GENERAL / PRIORITY / DEDICATED
   * on every plan model.
   */
  | "support.email.priority"
  /** The top rung of the same enum: a named contact, not a queue. */
  | "support.email.dedicated";

/** The canonical list, in the order the doc tables read. */
export const ENTITLEMENTS: readonly Entitlement[] = [
  "recording.capture",
  "recording.permanentStorage",
  "recording.publish",
  "support.email.priority",
  "support.email.dedicated",
];

/**
 * Human name per capability, used verbatim in the refusal sentence — so the
 * client that re-renders a `Refusal` names the same thing the server did.
 *
 * Being a `Record` over the union rather than a `Map` is the exhaustiveness
 * mechanism: adding a member to `Entitlement` without naming it here is a
 * build failure, so the one string every refusal depends on cannot go missing.
 */
export const ENTITLEMENT_LABEL: Record<Entitlement, string> = {
  "recording.capture": "session recording",
  "recording.permanentStorage": "permanent recording storage",
  "recording.publish": "recording publishing",
  "support.email.priority": "priority email support",
  "support.email.dedicated": "dedicated email support",
};

/** The refusal sentence's subject for one capability. */
export function describeEntitlement(key: Entitlement): string {
  return ENTITLEMENT_LABEL[key];
}

const grants = (...keys: Entitlement[]): ReadonlySet<Entitlement> =>
  new Set(keys);

/**
 * The matrix. Exhaustive over `B2CPlan` by construction, which is the entire
 * reason it is a `Record` and not a lookup with a default arm: adding a rung
 * to the union is a compile error here until the business has decided what it
 * grants, and a `PLAN_ENTITLEMENTS[plan] ?? new Set()` would silently hand
 * every new customer the empty set and lock them out of everything instead.
 *
 * Rungs are cumulative — every rung is a superset of the one below it, so
 * moving up can never take a capability away. That is a promise a customer
 * relies on when they pay, and it is a property of this table rather than a
 * convention, so it is worth stating what keeps it true:
 *
 *   - `recording.publish` is a strict subset of `recording.permanentStorage`
 *     (the publish route refuses anything not permanently stored), so the two
 *     are laddered together;
 *   - `support.email.dedicated` is a *stronger* form of
 *     `support.email.priority` — `PlanEmailSupport` is one enum with three
 *     values, and a named contact obviously is not also queued behind the
 *     general one. So a rung granting `dedicated` grants `priority` too, and
 *     the two are never alternatives on the same ladder.
 *
 * `CUSTOM` is the catch-all a bespoke plan lands in, so it holds everything.
 */
export const PLAN_ENTITLEMENTS: Record<
  B2CPlan,
  ReadonlySet<Entitlement>
> = {
  BASIC: grants("recording.capture", "support.email.priority"),
  EXTENDED: grants(
    "recording.capture",
    "support.email.priority",
    "support.email.dedicated",
  ),
  COMPREHENSIVE: grants(
    "recording.capture",
    "recording.permanentStorage",
    "support.email.priority",
    "support.email.dedicated",
  ),
  CUSTOM: grants(
    "recording.capture",
    "recording.permanentStorage",
    "recording.publish",
    "support.email.priority",
    "support.email.dedicated",
  ),
};

/** Every capability a rung grants, for a client that wants the whole set. */
export function entitlementsFor(plan: B2CPlan): ReadonlySet<Entitlement> {
  return PLAN_ENTITLEMENTS[plan];
}

/** The one question a guard asks. Total by design: there is no partial grant. */
export function hasEntitlement(
  plan: B2CPlan,
  entitlement: Entitlement,
): boolean {
  return PLAN_ENTITLEMENTS[plan].has(entitlement);
}

/* -------------------------------------------------------------------------- */
/* Numeric limits                                                              */
/* -------------------------------------------------------------------------- */

/**
 * A cap a plan puts on a buyer, as a number. `null` means unlimited.
 *
 * Session counts are deliberately absent from this union. They are not missing
 * by oversight: a session cap is a property of one *purchased subscription* and
 * not of the buyer's plan rung, and it already has exactly one home —
 * `subscriptionEntitlement()` (lib/booking/entitlement.ts), the ONE counter
 * every surface reads (#1766), which freezes `sessionsTotal` at purchase and
 * derives cycles from it. A second cap table keyed on the plan rung would be a
 * second answer to "how many sessions are left", and two answers is how an
 * allocator oversells a subscription. Route limits through the counter.
 */
export type PlanLimit = "recordingRetentionDays";

/** Subject of a limit sentence, in the same shape as `ENTITLEMENT_LABEL`. */
export const PLAN_LIMIT_LABEL: Record<PlanLimit, string> = {
  recordingRetentionDays: "recording retention",
};

export const PLAN_LIMITS: Record<
  B2CPlan,
  Readonly<Record<PlanLimit, number | null>>
> = {
  BASIC: { recordingRetentionDays: 14 },
  EXTENDED: { recordingRetentionDays: 14 },
  COMPREHENSIVE: { recordingRetentionDays: null },
  CUSTOM: { recordingRetentionDays: null },
};

/**
 * The cap, or `null` when the rung is unlimited. `null` is a real answer and
 * not "unknown": a caller that cannot distinguish the two will render
 * "You've hit your limit" to a customer on an unlimited rung.
 */
export function planLimit(plan: B2CPlan, key: PlanLimit): number | null {
  return PLAN_LIMITS[plan][key];
}

/* -------------------------------------------------------------------------- */
/* Rung labels and order                                                       */
/* -------------------------------------------------------------------------- */

export const B2C_PLAN_LABEL: Record<B2CPlan, string> = {
  BASIC: "Basic",
  EXTENDED: "Extended",
  COMPREHENSIVE: "Comprehensive",
  CUSTOM: "Custom",
};

/** Cheapest first, bespoke last. Display order and the upgrade path. */
export const B2C_PLAN_ORDER: B2CPlan[] = [
  "BASIC",
  "EXTENDED",
  "COMPREHENSIVE",
  "CUSTOM",
];

export function b2cPlanLabel(plan: B2CPlan): string {
  return B2C_PLAN_LABEL[plan];
}

/**
 * The cheapest rung above `plan` that grants `entitlement`, or `null` when
 * nothing above it does. This is what makes "the way out" name a *real*
 * destination: a refusal that points at a plan which still refuses is worse
 * than one that names no plan at all, because the customer pays and gets
 * nothing.
 */
export function upgradePathFor(
  plan: B2CPlan,
  entitlement: Entitlement,
): B2CPlan | null {
  const from = B2C_PLAN_ORDER.indexOf(plan);
  return (
    B2C_PLAN_ORDER.slice(from + 1).find((higher) =>
      PLAN_ENTITLEMENTS[higher].has(entitlement),
    ) ?? null
  );
}
