# B2C Entitlements

| Field | Value |
|---|---|
| Status | Proposed — module lands with no consumer yet |
| Audience | All engineers |
| Last reviewed | 2026-09-29 |
| Sibling doc | [`docs/authorization/README.md`](./README.md) for the three role matrices |
| Source files | `lib/entitlements/plan-entitlements.ts`, `lib/entitlements/errors.ts`, `lib/entitlements/index.ts` |

## 1. Background

The authorization subsystem has three working matrices and answers "who is this
user" three different ways. None of them answers **"what has this customer
paid for."**

That question had no home, so paid capabilities were enforced wherever the
person who needed the feature happened to be writing. The clearest surviving
example is permanent recording storage, enforced inline in a single route:

```typescript
// app/api/stream/recordings/[recordingId]/transfer/route.ts — as found
if (storagePolicy !== "PERMANENT") {
  return NextResponse.json(
    {
      error:
        "Permanent storage is available on plans with premium recording. Stream keeps this recording for 14 days — download it or upgrade your plan to keep it permanently.",
      code: "UPGRADE_REQUIRED",
    },
    { status: 403 },
  );
}
```

That is a plan gate, and it costs everything an authorization layer exists to
prevent: a **hand-rolled code** (`UPGRADE_REQUIRED`) that is not in
[`lib/labels/auth-errors.catalog.ts`](../../lib/labels/auth-errors.catalog.ts) and
therefore has no title and no `upgrade-plan` affordance; a **hardcoded English
string** where the catalog is meant to be the single translation seam; a status
chosen at the call site; and **no matrix**, so nothing can answer "which plans
grant this" or "does upgrading actually get me there."

This module is the missing axis.

## 2. Scope

| In scope | Out of scope |
|---|---|
| The B2C plan ladder and its capability matrix | The three role matrices — see §4 |
| Refusals for a missing capability and a reached cap | Session counts — owned by `lib/booking/entitlement.ts` (§8) |
| The `Refusal` shapes the two gates produce | Which routes enforce which gate (§10) |
| Adding a rung, adding a capability | Checkout, pricing, upgrade billing |

## 3. Where to Start

| # | Section | Reading time |
|---|---|---|
| 1 | [Why `PlanLevel` is not the key](#5-why-planlevel-is-not-the-key) | 3 min |
| 2 | [The ladder](#6-the-ladder) | 2 min |
| 3 | [The matrix](#7-the-matrix) | 2 min |
| 4 | [Calling it](#9-calling-it) | 3 min |
| 5 | [The declaration rule](#10-the-declaration-rule) | 2 min |

## 4. Four axes, not one

There are now four authorization axes. They are deliberately separate, and the
separation is a decision, not an oversight.

| Axis | Question | Keyed on | Matrix |
|---|---|---|---|
| Platform | What may this operator reach? | `UserRole` | [`lib/auth/backoffice-permissions.ts`](../../lib/auth/backoffice-permissions.ts) |
| Organisation | What may this member do? | `MemberRole` | [`lib/auth/org-permissions.ts`](../../lib/auth/org-permissions.ts) |
| Booking | How many sessions are left? | one purchased subscription | [`lib/booking/entitlement.ts`](../../lib/booking/entitlement.ts) (#1766) |
| **Plan** | **What has this customer paid for?** | **`B2CPlan`** | **`lib/entitlements/plan-entitlements.ts`** |

The reason for keeping them apart is the same reason the org role ladder was
retired in #1851: privilege is not one-dimensional, and a single rank or a
single matrix cannot express it. `BILLING_ADMIN` (70) outranks `MANAGER` (60)
yet must see less operationally. A customer can be simultaneously a platform
`ADMIN`, an org `OWNER`, mid-way through a subscription, and on a plan rung
that grants permanent storage — and collapsing any two of those into one
ordering invents a comparison the product does not have.

The axes are composed **at the consumer**, never ranked against each other. A
refusal here means "your plan does not include this," never "your role is too
low."

## 5. Why `PlanLevel` is not the key

`PlanLevel` looks like a tier and is not. It is
`BEGINNER | INTERMEDIATE | ADVANCED | ALL_LEVELS` (schema:6597), and it
describes **the offering the expert authored**:

- it is an author-supplied column on all four plan models, defaulting to
  `BEGINNER`, set from the planner form (`schemas/plans.ts:197`);
- its only reader is a **catalogue facet** — `app/explore/programs` filters and
  sorts browse results by it;
- it gates nothing, for anyone, anywhere in the codebase.

Gating permanent storage on it would say: *you may keep this recording only if
the plan you bought is tagged Beginner.* A ₹500 beginner course and a ₹50,000
beginner course are the same `PlanLevel`, and an advanced course is not a
**better** plan — it is a **harder** one. The seed files make the shape
obvious: `prisma/seedFiles/4b-create-subscription-plans.ts` writes one BEGINNER,
one INTERMEDIATE and one ADVANCED plan — three different courses by three
different experts, at three different prices.

> [!IMPORTANT]
> [`lib/labels/plan-labels.ts`](../../lib/labels/plan-labels.ts) is the
> standing proof that this vocabulary is a label table and nothing more, and it
> is deliberately **not** imported by the entitlements module. A second
> `PlanLevel`-shaped ladder inside the authorization folder is exactly the
> drift the three matrices were written to prevent.

## 6. The ladder

The B2C ladder has **no persisted home yet** — `User` has no plan column and
`ConsulteeProfile` (schema:3334) carries only `careerStage`, `budgetPreference`,
`isIndependent` and a GST code. Adding one is a schema change owned elsewhere,
so `B2CPlan` is declared locally and closed:

| Rung | Label | Basis |
|---|---|---|
| `BASIC` | Basic | `getSubscriptionType()` (utils/subscriptionValidation.ts:566) |
| `EXTENDED` | Extended | `ClassPlanType` (utils/classPlans.ts:10) |
| `COMPREHENSIVE` | Comprehensive | both |
| `CUSTOM` | Custom | both — the bespoke catch-all |

Those four are the only plan names the codebase already uses for a *purchased*
subscription, and two independent places agree on them. When a `B2CPlan` enum
lands in the schema, swap the union for a type-only import; nothing else in the
module changes (§11).

## 7. The matrix

Every capability below is tied to a column that already exists. A capability the
product does not implement is not a cheap entitlement to declare now and
enforce later — it is a word the refusal copy will confidently use to tell a
customer to upgrade for something they still cannot reach.

| Entitlement | Basic | Extended | Comprehensive | Custom | Evidence |
|---|:--:|:--:|:--:|:--:|---|
| `recording.capture` | ✅ | ✅ | ✅ | ✅ | `recordingEnabled` on all four plan models; `isRecordingEnabledForAppointment` (lib/stream/recording-utils.ts:81) via lib/stream/recording-consent.ts:68. #1134 P1-6 |
| `recording.permanentStorage` | — | — | ✅ | ✅ | `RecordingStoragePolicy` (schema:5256): STREAM_ONLY is commented "2-week temporary storage (free tier)", PERMANENT "kept in our own bucket indefinitely (premium tier)". Fail-closed in `resolveAppointmentStoragePolicy` |
| `recording.publish` | — | — | — | ✅ | app/api/stream/recordings/[recordingId]/publish/route.ts:131 — "Only permanently stored (premium plan) recordings can be published" |
| `support.email.priority` | ✅ | ✅ | ✅ | ✅ | `PlanEmailSupport` (schema:6604): GENERAL / PRIORITY / DEDICATED |
| `support.email.dedicated` | — | ✅ | ✅ | ✅ | same enum, top value |

Two invariants hold by construction, and both are worth stating because a
customer relies on them when they pay:

- **Rungs are cumulative.** Every rung is a superset of the one below it, so
  moving up can never take a capability away.
- **`publish` ⊆ `permanentStorage`**, because the publish route refuses
  anything not permanently stored. The two are laddered together.

`support.email.dedicated` is a *stronger form* of `support.email.priority`, not
an alternative: `PlanEmailSupport` is one enum with three values, and a named
contact is not also queued behind the general one. A rung granting `dedicated`
grants `priority` too.

## 8. Numeric limits

| Limit | Basic | Extended | Comprehensive | Custom |
|---|:--:|:--:|:--:|:--:|
| `recordingRetentionDays` | 14 | 14 | unlimited | unlimited |

> [!IMPORTANT]
> **Session counts are deliberately not a `PlanLimit`.** A session cap is a
> property of one *purchased subscription*, not of the buyer's plan rung, and
> it already has exactly one home: `subscriptionEntitlement()` in
> [`lib/booking/entitlement.ts`](../../lib/booking/entitlement.ts) — the ONE
> counter every surface reads (#1766), which freezes `sessionsTotal` at purchase
> and derives cycles from it. A second cap table would be a second answer to
> "how many sessions are left", and two answers is how an allocator oversells a
> subscription. **Route every session limit through the counter.**

`planLimit` returns `null` for unlimited, which is a real answer and not
"unknown" — a caller that cannot tell the two apart will tell an unlimited
customer they have hit a limit.

## 9. Calling it

### A server guard

`requireEntitlement` throws a `Refusal`, which `isRefusal` and `apiError`
(`lib/errors/index.ts`) already recognise. The worked example is the ad-hoc gate
from §1, rewritten:

```typescript
// ✅ Correct
import { apiError } from "@/lib/errors";
import { entitlementRefusal } from "@/lib/entitlements";

const { policy } = resolveAppointmentStoragePolicy(apt);
if (policy !== "PERMANENT") {
  // Predicate form, so the route can hand the refusal to the route's own error
  // shape. apiError is the catch-all, not a bare NextResponse.
  const refusal = entitlementRefusal(b2cPlan, "recording.permanentStorage");
  if (refusal) return apiError({ tag: "[Recording.transfer]", error: refusal });
}
```

`apiError` returns `{ error, errorType, code }` with the refusal's own status
and sentence (lib/errors/api-error.ts:36), which is why the code has to be one
the client already knows — see §9, *The codes*.

In a route where the gate is the whole handler, the throwing form is shorter:

```typescript
// ✅ Correct — throws a Refusal, caught by the route's error boundary
requireEntitlement(b2cPlan, "recording.permanentStorage");
```

In a server action, return the refusal as a value rather than throwing —
Next's `onRequestError` hook captures anything a `"use server"` function throws
(lib/errors/action-result.ts):

```typescript
// ✅ Correct
import { okResult, refusalResult } from "@/lib/errors";

const refusal = entitlementRefusal(b2cPlan, "recording.publish");
if (refusal) return refusalResult(refusal);
return okResult({ url: published });
```

> [!NOTE]
> The capability name is in the `userMessage` and the ids are in `context` and
> `devMessage` — never in the customer-facing string.

### Statuses

| Gate | Status | Why |
|---|---|---|
| Missing capability | **403** | The feature exists, is visible on the pricing page, and the copy exists to tell the customer how to reach it. [`docs/authorization/README.md`](./README.md) §7 reserves 404 for capability gates where the affordance must be **hidden** — the opposite case. A 404 would throw away the `upgrade-plan` affordance. |
| Reached cap | **409** | A statement about current state, not permission: the plan grants it, the cycle is full. `Refusal` defaults to 409 for exactly this, and the catalog's own `PLAN_LIMIT_REACHED` copy says "or wait for the current cycle to reset" — a transient answer. 403 would invite the customer to pay for something they already own. |

### A React component

Components read the matrix; they never build a `Refusal`. A server component
that only needs to show or hide a control:

```tsx
// ✅ Correct — a client component may import this: the module is Prisma-free
// and imports no server-only module
import { hasEntitlement, describeEntitlement } from "@/lib/entitlements";

{hasEntitlement(b2cPlan, "recording.publish") ? (
  <PublishRecordingButton />
) : (
  <UpgradeNudge feature={describeEntitlement("recording.publish")} />
)}
```

Read `hasEntitlement` in the **server** component that owns the gate and pass a
boolean down, when the matrix is known only on the server — the ladder is a
property of the buyer's purchase, so it rarely belongs in a client bundle.

### The codes

Both gates reuse codes the catalog already declares. `ENTITLEMENT_REFUSAL_CODES`
is `satisfies Record<string, keyof typeof AUTH_ERROR_COPY>`, so if either code
is ever renamed or dropped the **build fails** rather than emitting a refusal no
client can branch on. `entitlementCopy(code)` hands the client the catalog
entry — title, sentence and the `upgrade-plan` button — so the client renders
the same thing the server refused with. **Do not add a second code here.**

The catalog's `PLAN_FEATURE_NOT_INCLUDED` copy is deliberately generic
("Upgrade your plan to unlock this") because it is keyed by code alone and does
not know which feature was refused. `requireEntitlement` therefore *extends*
that sentence with the capability name rather than replacing it.

## 10. The declaration rule

> **Every route that enforces a plan gate must name its entitlement at the
> guard call site, and those names must live in one list.**

There is no other place to look. A handler that infers the gate — checking
`recordingStoragePolicy` inline, as §1 does — is a handler whose entitlement
cannot be enumerated, tested, or grepped. Two of them exist today (the transfer
and publish routes above); migrating them is the first consumer of this module.

When the list exists, the test suite can walk it and assert that

1. every `Entitlement` has a rung that grants it, and
2. every rung is reachable from the one below it (the cumulative invariant),
3. every `upgradePathFor` refusal names a rung that actually grants the
   capability — a customer who pays to follow a dead end is worse than one who
   is told no.

Testing is deferred, so (1)–(3) are not yet asserted anywhere.

## 11. How to add a plan

1. Add the rung to the `B2CPlan` union in `plan-entitlements.ts`.
2. `tsc` fails on **both** `PLAN_ENTITLEMENTS` and `PLAN_LIMITS` — that is the
   point of the `Record` shape. There is no default arm to silently inherit.
3. Give the new rung its entries, and check it is a superset of the rung below.
4. Add a label to `B2C_PLAN_LABEL` (also exhaustive) and place the rung in
   `B2C_PLAN_ORDER` — cheapest first, bespoke last, or the cheapest upgrade path
   `upgradePathFor` returns will be wrong.
5. If the rung is persisted, the union becomes a `import type` from
   `@prisma/client` and the matrix keys follow the enum automatically.

## 12. How to add an entitlement

1. Add the member to the `Entitlement` union. `ENTITLEMENT_LABEL` and
   `ENTITLEMENTS` then fail to compile until you name and order it.
2. Give the label the words the refusal sentence will use — it is read out
   verbatim to a customer.
3. Add the key to every rung that should grant it, respecting the cumulative
   invariant and any superset relationship (§7).
4. Confirm there is a column behind it. An entitlement with no backing column
   is a promise the product cannot keep.

## 13. Open items

Deliberately **not** done here, because each needs a file this change does not
own:

| # | Item | Why it is out of scope |
|---|---|---|
| 1 | Persist `B2CPlan` on `User` / `ConsulteeProfile` | Schema change, `prisma/schema.prisma` is owned elsewhere. Until then the ladder has no source and callers must supply it. |
| 2 | Migrate the two ad-hoc recording gates (§1) | Both routes belong to another owner; this module is additive by design. |
| 3 | Cross-link this doc from [`README.md`](./README.md) §11 | Existing file. |
| 4 | Import the retention constant from the transfer route | The `14` currently exists only in a user-facing string. This table is the first coded home; the route copy is the stale one. |
| 5 | Tests for §10 (1)–(3) | Testing deferred. |

## 14. Related Docs

- [`docs/authorization/README.md`](./README.md) — the three role matrices and
  the 401/403/404/409 conventions this module follows
- [`lib/booking/entitlement.ts`](../../lib/booking/entitlement.ts) — the one
  session counter this module deliberately does not duplicate
- [`lib/labels/auth-errors.catalog.ts`](../../lib/labels/auth-errors.catalog.ts) —
  the copy and codes both gates reuse
- [`lib/auth/org-permissions.ts`](../../lib/auth/org-permissions.ts) — the
  matrix-over-rank-ladder argument, which is why §4 keeps the axes apart
