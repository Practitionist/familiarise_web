# Public pages and discovery

The enterprise layer's only public-facing surface in the current
product is the org-curated catalog feeding the marketplace explore
experience:

1. **Org catalog** — a member-facing list of `OrganizationPlan` rows,
   the org-curated subset of the marketplace catalog.

> The standalone "public org page" surface (`/org/[slug]` page +
> `/api/organizations/public/[slug]` route) was removed in
> `2b9da181` along with the rest of the pre-Arch-4 stubs. The org
> identity that learners see now flows entirely through the explore
> badge described in **Explore-side visibility** below — there is no
> separate org landing page until the explore redesign brings one
> back as part of a real surface, not a stub.

## `OrganizationPlan`

```prisma
model OrganizationPlan {
  id             String @id @default(uuid())
  organizationId String
  planType       AppointmentsType   // CONSULTATION | SUBSCRIPTION | WEBINAR | CLASS | TRIAL
  title          String
  description    String?
  price          Int                // paise
  priceCurrency  Currency @default(INR)
  isActive       Boolean @default(true)
  config         Json
  assignedConsultantIds String[] @default([])
  ...
}
```

A plan is the org's curated offering — a subset of the platform
catalog plus (optionally) an assignment list of expert ids that the
org's members can book from. `enforceOrganizationPlans = true` on the
Organization restricts members to the org's list.

## Catalog CRUD

- `GET /api/organizations/[orgId]/catalog` — MANAGER. Lists
  `OrganizationPlan` rows, filterable by `planType` and `isActive`.
- `POST /api/organizations/[orgId]/catalog` — OWNER. Creates a plan.
- `DELETE /api/organizations/[orgId]/catalog` — OWNER. Bulk deactivate
  by `{ planIds: string[] }`.
- `GET /api/organizations/[orgId]/catalog/search?q=` — any active
  member. Postgres ILIKE on `title` + `description`. Returns a thin
  projection (no internal ids, no consultant assignments). This is a
  deliberately shallow search — at catalog sizes below ~5k plans it's
  cheaper than maintaining a Typesense index per tenant.

## Old per-plan routes

The pre-Arch-4 `/api/organizations/[orgId]/plans/**` placeholders
were deleted in `2b9da181` rather than left behind as 501 stubs. The
collection catalog route set above (`/catalog`, `/catalog/search`)
covers all current needs; per-plan CRUD will return as a real
implementation when the plan refactor PR lands, not before.

## Catalog search performance

With ILIKE:
- No full-text index. Queries are O(n) per tenant but tenants are small.
- Case-insensitive by flag, not by `lower()` index.
- Ordering is `createdAt DESC`; no relevance ranking.

When a single tenant's catalog exceeds ~5k rows the search route
should be swapped for the existing Typesense pipeline — the route is
sandboxed to make the swap a single-file change.

## Attribution-only semantics for PERSONAL funding

A `FundingSource = PERSONAL` org tags the learner's `Payment` with
`organizationId` so analytics can roll up "all sessions booked by Acme
employees". No money flows through the org — the learner pays at
checkout on their own card. This is the attribution leg `PaymentLeg`
cannot represent on its own (it carries source=CARD), so the org tag
lives on the `Payment.organizationId` column directly.

## Explore-side visibility

When `canHost = true` and the org has ACTIVE experts, the org's name
appears as a badge on each expert's marketplace card. The `/explore`
page resolves the badge by joining `Membership(status=ACTIVE,
role=EXPERT)` ordered by `createdAt ASC` so multi-org experts surface
a deterministic primary org.

The explore query itself is part of the marketplace surface and lives
outside the `/api/organizations` tree.

## Related docs

- `12-dashboard-pages.md` — dashboard pages that feed this surface.
- `06-expert-lifecycle.md` — how an expert becomes discoverable in the
  org's public context.
