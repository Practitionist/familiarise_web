# Feature flags and rollout

The enterprise layer ships behind a single process-env flag plus a
pattern of capability-gated UI. Flags live in `lib/feature-flags.ts`.

## `ENABLE_PROVIDER_ORGS`

```ts
export const ENABLE_PROVIDER_ORGS =
  process.env.ENABLE_PROVIDER_ORGS === "true";
```

Gates the host-side flow end-to-end. When `false` (pre-launch default):

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

### Flipping the flag

Set `ENABLE_PROVIDER_ORGS=true` in the deployment environment and
redeploy. The flag is *not* a runtime toggle — flipping it mid-stream
would mean some payments use the SPONSOR settlement path and others use
the HOST split, which is a compliance nightmare.

## Capability-gated UI

The dashboard sidebar reads capability booleans from the session and
hides pages that would 404 or render empty. See
`12-dashboard-pages.md` for the full matrix. Capability gating is
authoritative:

- A `canSponsor = false` org never sees `/contracts`, `/programs`,
  `/billing`, `/plans`, or `/purchase-orders`.
- A `canHost = false` org never sees `/consultants` or `/payouts`.

Both are navigation-level hides; the API gates remain
role-based-only — a MAINTAINER on a `canHost = false` org who hand-
crafts a `GET /api/organizations/[orgId]/payouts` request receives an
empty list, not a 501.

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
- `12-dashboard-pages.md` — page-by-page visibility matrix.
- `14-scenarios-and-examples.md` — worked end-to-end flows.
