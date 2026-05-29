# Organization hierarchy

`Organization` carries three hierarchy columns — `parentId`, `rootId`,
and `depth` — so a future multi-BU rollout lands without a migration.
The UI is NOT built in v1; these columns exist to make the data model
future-proof without committing to the UX yet.

## Schema

```prisma
model Organization {
  parentId String?
  parent   Organization? @relation("OrgTree", fields: [parentId], references: [id])
  children Organization[] @relation("OrgTree")
  depth    Int @default(0)
  rootId   String
  ...
  @@index([parentId])
  @@index([rootId])
}
```

- `parentId` — direct parent, nullable (root orgs have `parentId =
  null`).
- `rootId` — denormalised ancestor root id. For root orgs, `rootId`
  self-points at the org's own id. For nested orgs, it points at the
  top of the tree.
- `depth` — 0 for roots, +1 per level below.

Denormalising `rootId` and `depth` avoids recursive CTEs on every
tenant filter. A report "show me every session booked by any Wipro
subsidiary this quarter" runs as a flat
`WHERE organization.rootId = '<wipro-root-id>'` instead of a walk.

## Helpers

Three helpers in `lib/api/organizations/hierarchy.ts`:

### `deriveHierarchyFromParent(parentId)`

Returns `{ rootId, depth }` for a new org. Called at creation time:

- Top-level org: returns `{ rootId: null, depth: 0 }`. The API layer
  is expected to set `rootId = <the new org's own id>` after insert
  (the creation code runs this as a two-step "insert then update" or,
  in the current `POST /api/organizations` handler, generates the id
  client-side via `randomUUID()` so both columns can be populated in
  the same insert).
- Nested org: reads the parent's `rootId` + `depth + 1` and returns
  them verbatim.

### `rootIdOf(orgId)`

Single-row lookup of `rootId`. Used by reporting queries that need to
filter across a tenant subtree.

### `descendantIdsOf(orgId)`

Returns every org id in the subtree (including the root itself). Flat
query on the `rootId` index — no recursion.

## What is NOT implemented

- Re-parenting (moving a subtree under a new root). This would require
  a transactional walk that rewrites every descendant's `rootId` and
  `depth`. Out of scope for v1.
- Subtree UI (nested sidebar, breadcrumb, "switch to parent"). Not
  shipped.
- Subtree-scoped `requireOrgAccess` check. Platform admins still
  bypass the check; org-level membership is still scoped to a single
  org row (a user must be a member of each subsidiary independently).
- Consolidated reporting cron. The ids can be listed via
  `descendantIdsOf()`, but the roll-up pipeline that cross-foots
  spend/earnings across a subtree is a follow-up cron.

## Creation invariants

- A new root org: `parentId = null`, `rootId = <this org's own id>`,
  `depth = 0`. Enforced by `POST /api/organizations/route.ts` which
  generates the id upfront with `randomUUID()` and inserts both fields
  at once.
- A nested org: `parentId = <parent.id>`, `rootId = <parent.rootId>`,
  `depth = <parent.depth + 1>`. The only way to create a nested org
  in v1 is via admin SQL / seed script — the public POST handler does
  not accept a `parentId` in the body.

## Why keep the columns if there's no UI

Because:

1. The cost of unused columns is near zero (three int/string columns,
   two indexes).
2. The cost of adding them later includes a destructive migration on
   a table with uptime-critical indexes plus backfill for every
   existing row.
3. The cost of *not* having them when a customer asks tomorrow is a
   feature gap we can't close in a week.

Shipping the columns and the helpers lands the schema commitment
while keeping the UI deferred until a real multi-BU customer lands.

## Seed

`prisma/seedFiles/15a-create-organizations.ts` sets `rootId = id` for
every seeded org (no nesting in the seed data). The hierarchy helpers
are wired and tested but unexercised against a real subtree.

## Related docs

- `01-organization-types.md` — the flat capability model the hierarchy
  sits alongside.
- `50-scenarios-and-examples.md` — Wipro, which motivates the feature.
