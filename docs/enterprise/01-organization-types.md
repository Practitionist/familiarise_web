# Organization types — capability-driven

The `OrganizationKind` enum is gone. An organization's "type" is now
computed from two boolean columns on the `Organization` row and surfaced
via `deriveCapabilityKind()` in `lib/labels/org-labels.ts`.

## The two capability booleans

```prisma
model Organization {
  canSponsor Boolean @default(true)
  canHost    Boolean @default(false)
  capabilitiesExtra Json?   // escape hatch, e.g. { "RESELL": true }
  ...
}
```

| canSponsor | canHost | Derived kind | Meaning |
|------------|---------|--------------|---------|
| `true`     | `false` | `SPONSOR`    | Pays for its members' sessions. Has a `BillingAccount`. No hosting-side payout flow. |
| `false`    | `true`  | `HOST`       | Hosts experts who earn through the org. Has an `OrganizationPayoutAccount`. No billing account. |
| `true`     | `true`  | `HYBRID`     | Both flows run independently. Has both records. |
| `false`    | `false` | `INERT`      | Transitional — rejected at create time (`app/api/organizations/route.ts` validates `canSponsor || canHost`). |

`capabilitiesExtra` is a JSON blob reserved for one-off capabilities
(e.g. an org that also resells third-party content) so future additions
don't need a migration. The 90% path is covered by the two typed
booleans; consumers that care about the typed booleans must not read
`capabilitiesExtra` — its shape is deliberately undocumented.

## Why booleans and not an enum

A single enum collapses two orthogonal questions (does it buy? does it
sell?) into one column, which makes HYBRID a special case everywhere it
appears. Booleans let every consumer answer only the question it cares
about:

- Checkout reads `canSponsor` to decide whether org funding is even
  eligible.
- Payout reconciliation reads `canHost` to decide whether the org has
  an earnings flow.
- The dashboard reads both to render the navigation.

`deriveCapabilityKind()` still exists, but it is a presentation helper,
not an access gate.

## Label + badge source of truth

Every user-facing string for capability kind lives in
`lib/labels/org-labels.ts`:

| Capability | Label | Badge class |
|------------|-------|-------------|
| `SPONSOR`  | "Sponsor" | `bg-blue-100 text-blue-900 border-blue-200` |
| `HOST`     | "Host"    | `bg-emerald-100 text-emerald-900 border-emerald-200` |
| `HYBRID`   | "Hybrid"  | `bg-purple-100 text-purple-900 border-purple-200` |
| `INERT`    | "Inactive"| `bg-zinc-100 text-zinc-600 border-zinc-200` |

Descriptions (`CAPABILITY_DESCRIPTION`) are the authoritative tooltips;
the wizard, OrgSwitcher, and Home page all render straight from there.

## INERT guard

An INERT org can't exist in the wild:

- `POST /api/organizations` rejects a body with both booleans false
  (`CreateBodySchema.refine(v => v.canSponsor || v.canHost)` in
  `app/api/organizations/route.ts`).
- `PATCH /api/organizations/[orgId]` rejects any patch that would flip
  both to false (same guard, inline in the PATCH handler).

Flipping `canSponsor = false` also requires the wallet to be drained
first — see the PATCH guard in `app/api/organizations/[orgId]/route.ts`.
Otherwise the org would own a positive wallet balance with no billing
surface to reconcile it against.

## HYBRID semantics

A HYBRID org runs two independent flows:

1. **Sponsor side.** The sponsor flow is identical to a pure SPONSOR
   org: a `BillingAccount`, a `FundingSource`, optional contracts,
   programs, and invoices.
2. **Host side.** The host flow is identical to a pure HOST org: an
   `OrganizationPayoutAccount`, `OrganizationEarnings` rows created on
   each booking whose expert is a member of the org, and
   `OrganizationPayout` cycles.

The two flows never intersect inside a single `Payment` record. A HYBRID
org that sponsors its own expert's session routes the money through the
sponsor flow AND books an earnings row on the host flow — the two
settlements are computed from the same `Payment.amount` but each
uses its own `RateCard`.

## What replaced what

| Pre-Arch-4 term | Now | Notes |
|-----------------|-----|-------|
| `OrganizationKind.BUYER` | `canSponsor=true, canHost=false` | — |
| `OrganizationKind.PROVIDER` | `canSponsor=false, canHost=true` | — |
| `OrganizationKind.HYBRID` | `canSponsor=true, canHost=true` | — |
| `OrganizationProfile` | merged into `Organization` | branding + policies are now columns on the base row. |
| `OrganizationProfile.id` (session) | `organizationId` | session exposes the Organization id directly. |

## Related docs

- `02-funding-and-programs.md` — funding sources on the sponsor side.
- `04-roles-and-permissions.md` — roles are the same regardless of
  capability; seat of expert vs learner is controlled via Membership.
- `12-dashboard-pages.md` — which pages render for which capability.
- `14-scenarios-and-examples.md` — four end-to-end worked cases.
