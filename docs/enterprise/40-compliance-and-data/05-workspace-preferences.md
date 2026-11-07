---
title: Operator workspace preferences
band: 40-compliance-and-data
audience: sde2
status: live
last-reviewed: 2026-11-07
---

# Operator workspace preferences

Plain version: one human can run several orgs (a consultancy with
multiple client orgs, an M&A operator, a white-label reseller). This doc
is the small bag of preferences that follows _the person_ across all the
orgs they touch — which org to open first and how to format numbers in
the cross-org rollup. It is deliberately _not_ org settings; those follow
the org. Notification channels are not a workspace preference: the
operator's personal `NotificationPreference` switches are the only
channel control, exactly as for every other user.

Cross-org operators (users who own / manage more than one Organization)
get a per-account preferences row on `OrgWorkspaceProfile`. The
preferences back the **Settings** tab on the workspace dashboard
(`/dashboard/org-workspace/[id]/settings`) and influence the workspace
shell's routing and number / date formatting.

These are **per-operator**, **cross-org** preferences. Per-organization
settings (branding, SSO, billing config) live on the org itself at
`/dashboard/organization/[orgId]/settings` — see
[dashboard-pages](../30-programs-and-lifecycle/04-dashboard-pages.md).

**Persona.** A consultant-ops operator owns both **Wipro** (a SPONSOR
enterprise) and a **LearnPro** workspace (a HOST provider co). Their
`OrgWorkspaceProfile` remembers that Wipro is the
`defaultLandingOrganizationId` (so the dashboard opens there, not on the
operator overview), and pins `currencyDisplayCode = INR` so the cross-org "Outstanding" rollup reads in one currency — even
though each org's own billing pages still render in their own billing
currency. None of this touches either `Organization` row: swap the
operator and the same two orgs would remember a different default
landing. If the bell is noisy across two busy orgs, the operator turns
off In-App in their own notification panel; there is no workspace-level
channel switch.

## Schema

```prisma
model OrgWorkspaceProfile {
  id String @id @default(uuid())

  user   User   @relation(fields: [userId], references: [id], onUpdate: Cascade, onDelete: Cascade)
  userId String @unique

  // Operator preferences. Per-field docs: docs/enterprise/40-compliance-and-data/05-workspace-preferences.md.
  // Soft FK on default-landing org (plain String) so org deletes don't cascade here.
  defaultLandingOrganizationId String?
  /// Unread: personal NotificationPreference switches gate every channel; slated for drop with the next schema batch.
  notificationRoutingMode      NotificationRoutingMode @default(BELL_AND_EMAIL)
  locale                       String? // BCP-47 (e.g. "en-IN")
  currencyDisplayCode          String? // ISO 4217 (e.g. "INR")

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@map("org_workspace_profiles")
}
```

`notificationRoutingMode` and its `NotificationRoutingMode` enum stay in
the database only until the owner's next schema batch drops them. No code
reads or writes the column, the settings API does not return it, and
`PATCH` rejects it.

## Field-by-field

### `defaultLandingOrganizationId`

The org the workspace shell opens by default when the operator hits
the dashboard without a specific orgId in the URL. Examples:

- `/dashboard/org-workspace/{id}` → redirect to that org's home
- Empty (`null`) → show the operator overview (the default; nothing
  pinned)

**Why a soft reference (plain `String`, not a Prisma `@relation`):**
the column outlives the referenced org. An admin can deactivate an
org, but the workspace profile should not cascade-null in that case —
the API does a fresh ownership + status check on read and resolves
to `null` when the pinned org is no longer accessible to the operator.

**Server-side validation** (`PATCH /api/org-workspace/[id]/settings`):
the new value must resolve to an ACTIVE OWNER `Membership` for the
calling user. Otherwise the API returns 400 `DEFAULT_LANDING_ORG_INVALID`.

### `locale`

BCP-47 tag (e.g. `en-IN`, `en-US`, `fr-CA`). Drives `Intl.NumberFormat`
and `Intl.DateTimeFormat` in the **cross-org workspace shell only** —
per-org pages render in the org's own region defaults.

The settings UI offers a four-tag preset list (en-IN, en-US, en-GB,
hi-IN) plus a `Custom…` escape hatch for operators with unusual locales.
Server-side validation is a permissive regex; we let `Intl` itself
reject malformed tags at render time rather than maintain a strict
allowlist.

### `currencyDisplayCode`

ISO 4217 three-letter code (e.g. `INR`, `USD`, `EUR`, `AED`). Applied
to the cross-org rollup numbers on the workspace home (e.g. "Outstanding
INR"). Per-org billing pages always render in the org's own billing
currency — this column is the operator-overlay for the cross-org
summary view only.

## API

```
GET   /api/org-workspace/[orgWorkspaceId]/settings
PATCH /api/org-workspace/[orgWorkspaceId]/settings
```

Auth: the URL's `orgWorkspaceId` must match the caller's
`auth.session.user.orgWorkspaceProfileId`. Mirrors the IDOR posture in
the workspace billing route — operators never see another operator's
preferences.

GET response shape:

```json
{
  "profile": {
    "id": "9a0a9de2-…",
    "defaultLandingOrganizationId": null,
    "locale": "en-IN",
    "currencyDisplayCode": null,
    "updatedAt": "2026-05-19T17:14:28.327Z"
  },
  "candidateOrgs": [
    { "id": "ca71b9cd-…", "name": "GitHub India Test", "status": "ACTIVE" },
    { "id": "c9ef5190-…", "name": "Test 2026 WZ Wizard Co", "status": "ACTIVE" }
  ]
}
```

The `candidateOrgs` array carries the operator's ACTIVE OWNER
memberships so the settings UI can render the picklist without a
second round-trip. DEACTIVATED orgs are filtered out (you can't pin
a tombstoned org as your landing target).

PATCH body uses an optional-undefined-vs-null trichotomy:

- Key absent → don't touch this column
- Key = `null` → clear this column
- Key = string → set this column

So a partial PATCH that only carries `{ "locale": "fr-CA" }` won't
clobber the other columns. The body is strict: an unknown key, including
the removed `notificationRoutingMode`, is a 400.

## UI

Workspace settings has three sections, each at its own URL under
`/dashboard/org-workspace/[id]/settings/<key>`:

1. **Default landing organization** — `DefaultLandingOrgSection.tsx`,
   with its own Save button.
2. **Notifications** — the operator's personal
   `NotificationPreferencesPanel`, the same panel every other dashboard
   shows. It writes `NotificationPreference` through
   `PUT /api/novu/preferences`, not this route.
3. **Account** — sign-in security, sessions and consent.

Locale and currency display have no section yet; they stay hidden until
something reads them.

## When to reach for this vs. `Organization.*`

Use this decision table to determine whether a new preference belongs on `OrgWorkspaceProfile` (per-operator, follows the person across orgs) or on one of the `Organization`-scoped models (shared by every member of that org).

| Setting              | Lives on                  | Scope                          |
| -------------------- | ------------------------- | ------------------------------ |
| Default landing org  | `OrgWorkspaceProfile`     | Per-operator, cross-org        |
| Cross-org locale     | `OrgWorkspaceProfile`     | Per-operator, cross-org        |
| Org name / branding  | `Organization`            | Per-org, shared by all members |
| Org SSO config       | `OrganizationSSOSettings` | Per-org                        |
| Org billing currency | `BillingAccount.currency` | Per-org                        |
| Org GST/PAN          | `Organization`            | Per-org                        |

The discriminator: if the preference would differ between two operators
on the same org, it belongs here. If it's an org-level fact, it lives
on `Organization` (or the relevant org-scoped sub-model).

## Deprecated & Superseded Approaches

- **Workspace notification routing (removed 2026-11-07).** `notificationRoutingMode` (`BELL_AND_EMAIL`, `BELL_ONLY`, `EMAIL_ONLY`, `NEITHER`) was an account-wide channel gate ANDed with the personal switches. The profile is one-to-one with the operator's own user, so it duplicated those switches; see decision 12 of `docs/decisions/2026-11-06-notification-single-preference-owner.md`. The column is unread until the next schema batch drops it.
