# Public Pages and Discovery

**Status**: Implemented (Apr 2026)
**Branch**: `feature/enterprise`
**Scope**: PROVIDER and HYBRID orgs (ACTIVE status only)

## Overview

PROVIDER and HYBRID organizations get a public presence on the Familiarise platform through three surfaces: a dedicated org page at `/org/[slug]`, a listing in the company directory at `/explore/companies`, and a small badge on affiliated consultant cards in the expert explorer at `/explore/experts`. BUYER orgs have no public visibility -- they are internal-facing entities (corporates/schools buying coaching for employees/students).

---

## Public Org Page: /org/[slug]

### What It Shows

```
+------------------------------------------------------+
|  [Logo]  Organization Name                            |
|          [Industry Badge]                             |
|          Description text...                          |
|          [Users icon] 12 consultants  [Globe] Website |
+------------------------------------------------------+
|                                                       |
|  Our Consultants                                      |
|  +-------------+  +-------------+  +-------------+   |
|  | [Avatar]    |  | [Avatar]    |  | [Avatar]    |   |
|  | Name        |  | Name        |  | Name        |   |
|  | Headline    |  | Headline    |  | Headline    |   |
|  | * 4.8  5yr  |  | * 4.2  3yr  |  | * 4.9  8yr  |   |
|  +-------------+  +-------------+  +-------------+   |
|                                                       |
|  Are you a consultant? Join this organization.        |
|  [ Browse all organizations ]                         |
+------------------------------------------------------+
```

- **Hero section**: Logo, banner image, org name, industry badge, description, consultant count, website link
- **Branding**: `primaryColor` and `secondaryColor` from `OrganizationProfile` applied as a CSS gradient on the hero
- **Banner image**: Rendered behind the hero with 20% opacity overlay
- **Consultant roster**: Grid (1/2/3 columns responsive) of cards showing name, avatar, headline, rating, experience, verified badge
- **CTA**: "Browse all organizations" link pointing to `/explore/companies`

### Access Rules

The page returns a Next.js `notFound()` (404) when any of these conditions are true:

- No organization exists for the given slug
- The org has no `organizationProfile`
- `kind` is neither `PROVIDER` nor `HYBRID`
- `status` is not `ACTIVE`

### Server Component

The page is a React Server Component that queries Prisma directly (no API call). The query fetches:

- Organization: `id`, `name`, `slug`, `logo`
- OrganizationProfile: `kind`, `status`, branding fields, `description`, `industry`, `website`
- Members: filtered to `role: ORG_CONSULTANT`, `status: ACTIVE`, with nested `user` (name, image) and `consultantProfile` (headline, rating, isVerified, experience)

Each consultant card links to `/explore/experts/[consultantProfileId]`.

**File**: `app/org/[slug]/page.tsx`

---

## Company Directory: /explore/companies

### What It Shows

```
+------------------------------------------------------+
|  [Building2]  Consulting Organizations               |
|  Browse agencies and organizations that host expert   |
|  consultants on Familiarise.                         |
+------------------------------------------------------+
|                                                       |
|  +-------------+  +-------------+  +-------------+   |
|  | [Logo]      |  | [Logo]      |  | [Logo]      |   |
|  | Org Name    |  | Org Name    |  | Org Name    |   |
|  | [Industry]  |  | [Industry]  |  | [Industry]  |   |
|  | Description |  | Description |  | Description |   |
|  |-------------|  |-------------|  |-------------|   |
|  | 5 consultants  | 12 consultants | 3 consultants  |
|  +-------------+  +-------------+  +-------------+   |
+------------------------------------------------------+
```

- Grid of company cards (1/2/3 columns responsive)
- Each card shows: logo (or `Building2` icon fallback), name, industry badge, description (2-line clamp), consultant count, website indicator
- Cards link to `/org/[slug]`
- Empty state: "No organizations listed yet. Check back soon!"

### Data Source

Server component with direct Prisma query on `OrganizationProfile`:

```
where: {
  kind: { in: ["PROVIDER", "HYBRID"] },
  status: "ACTIVE",
}
orderBy: { createdAt: "desc" }
```

Includes a count of active `ORG_CONSULTANT` members for each org.

**File**: `app/explore/companies/page.tsx`

---

## Org Badge on Consultant Cards

### How It Works

On the `/explore/experts` page, consultants affiliated with a PROVIDER or HYBRID org display a small badge next to their verified badge:

```
  John Smith [Verified] [TechConsult Agency]
```

The badge is an outlined `Badge` component with a `Building2` icon and the org name, styled in indigo. Clicking it navigates to `/org/[slug]`.

### Data Flow

```
consultantListInclude (lib/data/explore-experts.ts)
       |
       +-- orgMembershipInclude
              |
              +-- organizationMemberProfiles
                    where: role = ORG_CONSULTANT
                           status = ACTIVE
                           org.kind in [PROVIDER, HYBRID]
                           org.status = ACTIVE
                    select: organization.name, slug, logo
                    take: 1
       |
       v
API route maps first result to:
  organizationBadge: { name, slug, logo }
       |
       v
ConsultantCard renders badge (if organizationBadge truthy)
```

The `orgMembershipInclude` is a separate include block (not under `as const`) to avoid Prisma readonly array type issues. It takes only the first matching membership, so consultants in multiple orgs show only one badge.

### Key Files

| File | Purpose |
|------|---------|
| `lib/data/explore-experts.ts` | `consultantListInclude` and `orgMembershipInclude` definitions |
| `app/explore/experts/components/ConsultantCard.tsx` | Badge rendering (search for `organizationBadge`) |
| `types/consultant.ts` | `IConsultantCardData` type with `organizationBadge` field |

---

## Public API

### GET /api/organizations/public/[slug]

No authentication required. Returns public-facing org data for PROVIDER/HYBRID orgs.

**Response (200)**:
- `organization`: `{ id, name, slug, logo }`
- `profile`: `{ description, industry, website, logo, bannerImage, primaryColor, secondaryColor }`
- `consultants`: Array of `{ id, name, image, headline, rating, isVerified, experience }`
- `consultantCount`: Number of active ORG_CONSULTANT members

**Response (404)**: Returned for non-PROVIDER/HYBRID orgs, non-ACTIVE orgs, or unknown slugs. Error message is a generic "Organization not found" to avoid leaking existence of BUYER orgs.

The query mirrors the server component page -- same data, same access rules, but available as a JSON API for potential mobile clients or third-party integrations.

**File**: `app/api/organizations/public/[slug]/route.ts`

---

## Key Files

| File | Purpose |
|------|---------|
| `app/org/[slug]/page.tsx` | Public org page (server component) |
| `app/explore/companies/page.tsx` | Company directory listing |
| `app/explore/experts/components/ConsultantCard.tsx` | Org badge on consultant cards |
| `lib/data/explore-experts.ts` | Shared Prisma includes for org membership |
| `app/api/organizations/public/[slug]/route.ts` | Public API for org profile |
| `types/consultant.ts` | `IConsultantCardData` type definition |

---

## Edge Cases

| Case | Behavior |
|------|----------|
| Org deactivated after page cached | Next request hits Prisma, gets non-ACTIVE status, returns 404 |
| Consultant removed from org but page cached | Next roster query excludes non-ACTIVE members |
| Org has zero consultants | Roster section shows "No consultants listed yet." |
| BUYER org slug accessed at /org/[slug] | Returns 404 (BUYER orgs have no public page) |
| Consultant in multiple PROVIDER orgs | Badge shows only the first active membership (take: 1) |
| Org slug collision at creation | Retry with random suffix appended (e.g., `techconsult-a3kz7m`) |
