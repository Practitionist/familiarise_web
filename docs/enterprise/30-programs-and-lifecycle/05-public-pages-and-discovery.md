# Public pages and discovery

> **What this covers:** how an org and its plans surface on the public
> marketplace — the `OrgPlanVisibility` gate on per-type plans, the public org
> list/detail pages, the `PERSONAL`-funding attribution leg, and the explore
> badge. **Audience:** anyone touching marketplace discovery or org public
> exposure. Last verified against code 2026-06-05 (#726/#778).

The enterprise layer's public-facing footprint is two things:

1. **Per-type org-owned plans** that opt into the marketplace via
   `OrgPlanVisibility` (the org "catalog" is now just its visible plans, not a
   separate model).
2. **Public org pages** for HOST/HYBRID orgs that opt into discovery
   (`Organization.isPublic = true`).

> The standalone `OrganizationPlan` model **and** the `/catalog` route set were
> removed (#778 elegance pass): a separate "org catalog" table duplicated the
> bookable shape of the four per-type plans. The catalog an org exposes is now
> exactly its `ConsultationPlan` / `SubscriptionPlan` / `WebinarPlan` /
> `ClassPlan` rows (with `organizationId` set) whose `visibility` is public. Do
> not reintroduce `OrganizationPlan`.

## Plan visibility (`OrgPlanVisibility`)

Each of the four per-type plan models carries:

```prisma
enum OrgPlanVisibility {
  PUBLIC          // visible everywhere (default for personal plans)
  ORG_ONLY        // only org members see it; marketplace MUST filter it out
  ORG_AND_PUBLIC  // discoverable AND surfaced to org members
}
```

```prisma
// on ConsultationPlan / SubscriptionPlan / WebinarPlan / ClassPlan
visibility OrgPlanVisibility @default(PUBLIC)
```

The single source of truth for "what's safe to show publicly" is
`lib/api/plans/visibility.ts`:

```ts
export const MARKETPLACE_VISIBILITY: OrgPlanVisibility[] = [
  "PUBLIC",
  "ORG_AND_PUBLIC",
];
```

Every public plan-list surface composes `marketplaceVisibilityWhere()` (or the
shared `buildPlanWhereClause`) into its `where` so an `ORG_ONLY` plan never
leaks to `/explore/**`. The filter is applied in the `/api/plans/*` list routes
(consultations, subscriptions, webinars, classes), `plan-filters.ts`'s
`buildPlanWhereClause` (webinars + classes), and the consultant-detail GET
(narrows included plans for non-privileged viewers). **Org-internal** catalog
endpoints (operators viewing their own org's plans) MUST NOT use this filter —
they accept `ORG_ONLY` for the viewer's own org by design. Routing every public
surface through one constant keeps the tenant-private-catalog-leak class (#726)
auditable.

## Public org pages

A HOST/HYBRID org that sets `Organization.isPublic = true` becomes discoverable:

- **List:** `app/explore/enterprise/organisations/page.tsx`, backed by
  `GET /api/organizations/public` (unauthenticated). The query is hard-filtered
  to `isPublic = true AND canHost = true AND status = "ACTIVE"`, with optional
  `industry` (case-insensitive contains) + `search` filters and 1-indexed
  pagination (`limit` default 12, max 50).
- **Detail:** `app/explore/enterprise/organisations/[orgSlug]/page.tsx`
  (`revalidate = 60`). Resolves the org by `slug` under the same
  `isPublic + canHost + ACTIVE` guard and renders branding + up to 6 of each
  per-type plan filtered to `visibility ∈ {PUBLIC, ORG_AND_PUBLIC}`.

> **SPONSOR-only orgs are never public.** `canHost = false` orgs are B2B clients,
> not marketplace participants — exposing them would breach the confidentiality
> corporate clients expect, so both the list and detail queries require
> `canHost = true`. (This is also why there's no generic `/org/[slug]` page: the
> public surface is the explore-enterprise org page above, gated on hosting.)

## Attribution-only semantics for PERSONAL funding

A `FundingSource = PERSONAL` org tags the learner's `Payment` with
`organizationId` so analytics can roll up "all sessions booked by Acme
employees". No money flows through the org — the learner pays at checkout on
their own card. This is the attribution leg `PaymentLeg` can't represent on its
own (it carries `source = CARD`), so the org tag lives on the
`Payment.organizationId` column directly.

## Explore-side visibility (the org badge)

When `canHost = true` and the org has ACTIVE experts, the org's name appears as
a badge on each expert's marketplace card. The explore query resolves the badge
by joining `Membership(status = ACTIVE, role = EXPERT)` ordered by
`createdAt ASC` so a multi-org expert surfaces a deterministic primary org. The
`ConsultantProfile.isIndependent` flag (true when a profile has no active EXPERT
membership) decides whether the "hosted by &lt;org&gt;" badge renders at all.
The explore query itself is part of the marketplace surface and lives outside
the `/api/organizations` tree.

## Related docs

- [Dashboard pages](04-dashboard-pages.md) — the org-internal surfaces that feed this.
- [Expert lifecycle](03-expert-lifecycle.md) — how an expert becomes discoverable in the org's public context.
- [Feature flags & rollout](06-feature-flags-and-rollout.md) — `OrgPlanVisibility` in the flag/gating picture.
