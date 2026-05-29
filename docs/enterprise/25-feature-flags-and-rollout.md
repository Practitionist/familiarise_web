# Feature flags and rollout

The enterprise layer ships behind a single process-env flag plus a
pattern of capability-gated UI and inline WIP banners. Flags live in
`lib/feature-flags.ts`.

## `ENABLE_HOST_ORGS`

```ts
export const ENABLE_HOST_ORGS =
  process.env.ENABLE_HOST_ORGS === "true";
```

> Renamed from `ENABLE_PROVIDER_ORGS` in the Arch-4 terminology purge
> (`lib/feature-flags.ts:39`) — "provider" is dead vocabulary; the
> capability is `canHost` and the kind label is `HOST`. No back-compat
> shim because the app is pre-launch.

Gates the host-side **settlement** flow. When `false` (pre-launch default):

- `lib/payments/payouts/earnings-service.ts#resolveOrgShare` short-
  circuits to `null` — no `OrganizationEarnings` rows are written even
  if the schema says the expert has a `canHost = true` org.
- Dashboard pages (`/consultants`, `/payouts`, `/analytics` host-side
  panels) still render, but the data is empty so nothing user-visible
  leaks.

API routes under `/api/organizations/[orgId]/payouts`,
`/earnings`, `/payout-account`, and the rate-card endpoints no longer
reject with 501 when the flag is off — they return real data, just
always empty for orgs that aren't actively hosting. The hard gate is
at the settlement layer, not at the API edge. This is a deliberate
change from the pre-Checkpoint-9 behaviour documented in older
harness prompts.

`POST /api/organizations` does **not** check this flag either — a
canHost org can be created, members assigned, and rate cards stored.
The earnings just won't accrue until the flag flips. The wizard's
`OrgInfoStep` mounts a WIP banner when canHost is checked so operators
know the gap without needing to read this doc.

### Flipping the flag

Set `ENABLE_HOST_ORGS=true` in the deployment environment and
redeploy. The flag is *not* a runtime toggle — flipping it mid-stream
would mean some payments use the SPONSOR settlement path and others use
the HOST split, which is a compliance nightmare.

## Capability-gated UI

The dashboard sidebar reads capability booleans from the session and
hides pages that would 404 or render empty. See
`23-dashboard-pages.md` for the full matrix. Capability gating is
authoritative:

- A `canSponsor = false` org never sees `/contracts`, `/programs`,
  `/billing`, `/plans`, or `/purchase-orders`.
- A `canHost = false` org never sees `/consultants` or `/payouts`.

Both are navigation-level hides; the API gates remain
role-based-only — a MAINTAINER on a `canHost = false` org who hand-
crafts a `GET /api/organizations/[orgId]/payouts` request receives an
empty list, not a 501.

## WIP banners — partial implementations stay visible

The enterprise grid has permutations whose schema + API are wired but
whose end-to-end financial / dashboard surface is still in flight. The
2026-04-27 readiness review (`#issuecomment-4324209819`) recommended
hiding these from self-service. We took the opposite call: keep them
selectable, surface a WIP banner at the call site, and link the open
issue. Hiding now risks forgetting to re-enable later; banners keep
the gap auditable.

The banner component lives at
`components/enterprise/EnterpriseWipBanner.tsx`. Mount it on every
permutation that's flagged for follow-up; pass the issue numbers it's
tracking. Current mounts:

| Mount point | Trigger | Tracked issue(s) |
|---|---|---|
| `BillingStep.tsx` | `fundingSource === "PERSONAL"` on a sponsor org | #714 |
| `OrgInfoStep.tsx` | `canHost = true` checked | #662, #716 |
| `programs/page.tsx` | `programType === "CREDIT_POOL"` | #715, #716 |
| `programs/page.tsx` | `overageBehavior` is `CHARGE_MEMBER` or `CHARGE_ORG` | #715 |

The matching server-side `TODO(#NNN)` comments live next to the schemas
that accept these values (`schemas/organizations.ts`,
`app/api/organizations/[orgId]/programs/route.ts`,
`app/api/organizations/route.ts`) so a future contributor doing a
surface sweep can find every permutation in one search:

```bash
rg 'TODO\(#7(14|15|16|62)\)' app lib schemas
```

When a permutation's downstream side effect ships, drop the banner
mount and the matching `TODO(#NNN)` in the same commit. The full sweep
is tracked in **#730 — Enterprise v1 production-grid lockdown**; that
issue stays open until every banner above is gone.

## Plan visibility (`OrgPlanVisibility`)

Org-owned plans (`ConsultationPlan` / `SubscriptionPlan` /
`WebinarPlan` / `ClassPlan` with `organizationId` set) carry an
`OrgPlanVisibility` enum (`PUBLIC` / `ORG_ONLY` / `ORG_AND_PUBLIC`).
Personal plans default to `PUBLIC`; org-owned plans default to
`ORG_AND_PUBLIC` until an operator switches them to `ORG_ONLY`.

Public marketplace endpoints filter via
`lib/api/plans/visibility.ts` so a private org-owned plan never leaks
to `/explore/**`. The filter is applied in:

- `app/api/plans/{consultations,subscriptions,webinars,classes}/route.ts`
- `app/api/plans/shared/plan-filters.ts` (covers webinars + classes via
  `buildPlanWhereClause`)
- `app/api/user/consultants/[id]/route.ts` (the consultant detail GET
  narrows included plans for non-privileged viewers)

Org-internal catalog endpoints (operators viewing their own org's
plans) MUST NOT use this filter — those surfaces accept `ORG_ONLY` for
the viewer's own org by design.

## Data-residency flag

Not a feature flag per se, but worth noting:
`Organization.dataResidencyRegion: DataRegion` is read at write time
for audit logs and consent artifacts. Rows written against an org with
`dataResidencyRegion = IN` must never be replicated to US-hosted
infrastructure. v1 enforces this at application layer via a shared
helper in `lib/compliance/`; a future PR will add a DB trigger that
rejects writes from the wrong replica.

## Rollout sequence

The layer ships in one piece — there is no per-feature flag for
wallet vs invoice vs license, because the schema they share is already
deployed. The rollout order for new customers:

1. Sponsor org onboarding (`PERSONAL` or `WALLET` to start).
2. Invite members (LEARNER role).
3. First test booking that exercises the full `PaymentLeg` path.
4. (Optional) Upgrade to `INVOICE` or `LICENSE` once the customer
   signs a contract.
5. (Optional) Enable `canHost` once the host-side KYC is cleared.

No per-feature toggles are exposed to orgs.

## Related docs

- `01-organization-types.md` — capability booleans.
- `23-dashboard-pages.md` — page-by-page visibility matrix.
- `50-scenarios-and-examples.md` — worked end-to-end flows.
