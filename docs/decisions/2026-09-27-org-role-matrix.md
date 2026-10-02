# ADR: The organization role × page × tab matrix, and API responses shaped by role

- **Status**: Accepted
- **Date**: 2026-09-27
- **Part of**: #1527, PR #1842

> **Superseded in part (PR #1878):** SCIM was removed before launch, so `identity.manage` and `identity.read` now cover Domains and SSO only.

## Context

The organization dashboard gates access to its pages through `lib/auth/org-permissions.ts`, a matrix keyed by `OrgSurface` rather than by a numeric rank ladder. The file's own comment explains why a rank ladder does not work here: an organization has an operations track (MANAGER, SUPPORT), a finance track (BILLING*ADMIN), and member roles (EXPERT, LEARNER), and privilege is not one-dimensional across them. BILLING_ADMIN outranks MANAGER numerically in the general role hierarchy, yet must see \_less* on operations surfaces ("operator-blind" by design), and SUPPORT sees _more_ than EXPERT on those same surfaces. A rank comparison stays correct only for genuine management hierarchy — OWNER above MAINTAINER above MANAGER — and surface access needed its own source of truth.

Before this PR, that matrix existed but had drifted from the pages and API routes that were supposed to consume it. A dedicated agent matrixed every organization role against every page and tab during this PR's build and found concrete gaps: a BILLING_ADMIN landing on the organization Overview page got a 403, because the page's underlying read required `operations.read` rather than a finance grant; the "Generate invoice" button called a route that did not exist; an EXPERT who delivered an org-funded session got a 404 opening that session's detail page; and a SUPPORT role, whose job is member-facing triage, could see money figures on the Analytics page that had nothing to do with support work. The owner closed the remaining gaps across two decision rounds after this PR opened.

## Decision

### The final matrix

`lib/auth/org-permissions.ts` defines an `OrgSurface` union (for example `members.read`, `billing.read`, `payouts.manage`, `audit.read.ops`, `consent.requestWithdrawal`) and maps each surface to the `Set<MemberRole>` allowed to hold it, built from named tiers (`GOVERNANCE`, `OPERATORS`, `OPERATIONS_READERS`, `FINANCE_READERS`, `FINANCE_MUTATORS`) so the matrix reads as policy rather than as repeated role lists. The shape this PR locked:

- **OWNER** alone keeps the security-sensitive writes and the secret values: `contracts.manage` and `identity.manage` (Domains/SSO/SCIM writes and their secrets). `identity.read` is a status-only read that MAINTAINER also holds, and `programs.manage` and `appointments.actForOrg.cancel` (cancelling an org-funded booking issues a refund) stay with governance, which is OWNER and MAINTAINER.
- **MAINTAINER** manages General settings and Branding, and reads Domains/SSO/SCIM without being able to change them.
- **BILLING_ADMIN** keeps Billing and Payouts (`billing.manage`, `payouts.manage`) plus read-only Contracts and Programs, but does **not** get Appointments › Everyone — a finance role has no operational reason to see every appointment on the org.
- **MANAGER** is Billing read-only with no Payouts access at all, and gains three things this round: the Appointments › Unscheduled tab (read-only), the ability to reschedule an org-funded booking on the org's behalf (`appointments.actForOrg.reschedule`, owner decision Q11 — cancel stays with OWNER/MAINTAINER because it touches money), and seat assign/unassign on Programs (`programs.assign`, distinct from `programs.manage`, which is program _design_ and stays with governance).
- **SUPPORT** keeps Members › All and Appointments › Everyone, both read-only, with every money figure stripped from what it reads.
- **Every active member**, regardless of role, sees a names-only roster (`members.directory`: name, avatar, role label, no spend or utilisation figures); only operators (`members.read`) see the full member table.
- **Data exports** split into two bundles by `OrgDataExportKind` (`PEOPLE`, `FINANCE`, and a `FULL` value that preserves the pre-split behaviour for rows created before this change): the people bundle needs `dataExports.people` (OWNER + MAINTAINER), the finance bundle needs `dataExports.finance` (OWNER + BILLING_ADMIN).
- **DPDP consent** can only be _granted_ by the member it belongs to — no operator surface grants consent on someone else's behalf (`consent.read`/`consent.requestWithdrawal` let an operator view status and record a withdrawal request on the member's behalf, never a grant and never the withdrawal itself).
- **A SUSPENDED member** keeps read-only access to Appointments › Mine, the appointment detail page, and Join for a session they already booked, but cannot make a new org-funded booking and cannot cancel or reschedule one (a typed 403 fires before any refund or quote logic runs). Operators see an action item listing that member's upcoming funded sessions, so the suspension is not silent to the people who manage the org.
- **`supportRequests.org`**, added after this ADR was first written, is the union of `OPERATIONS_READERS` and `FINANCE_READERS` — in practice, any role holding `operations.read` or `billing.read`. It gates the new-request form's "About: <org>" option, the create route's server-side check before it stamps `organizationId` onto a ticket, and the org Support page's "Organization requests" tab and its backing `GET /api/organizations/[orgId]/support-tickets` route. Library (Documents · Recordings) follows a different rule from the rest of this matrix: its Mine scope is open to every ACTIVE or SUSPENDED member regardless of role, because it is the member's own session history, while its Everyone scope stays behind `operations.read` like the rest of the operations surfaces.

`lib/auth/org-permissions.ts` also documents, and this ADR restates, that capability gates such as `canSponsor`, `canHost`, `requiresPO` and `fundingSource` are deliberately **not** part of this matrix — they describe the shape of the organization itself, not the member's role inside it, and are combined with the matrix at each individual consumer (sidebar visibility, page guard, or API route) rather than folded into the role sets.

### API responses are shaped by role, not just hidden in the UI

The gaps this round closed were, in every case, API-level over-exposure, not merely a UI element that happened to render for the wrong role. This PR's rule, and the one this ADR records for future surfaces, is that **an API response must already be shaped for the caller's role before it reaches the client** — hiding a field in a component is not a substitute for not sending it. Concretely, this round:

- Restricted org-details money fields (on the endpoint the Overview and Analytics pages read) to callers holding `billing.read` or `payouts.read`, rather than sending every field and letting the page decide what to render.
- Removed every program assignee's name, email, utilisation and `consumedPaise` from the Programs read for roles that hold `programs.read` but not `programs.assign` or `programs.manage`.
- Raised the Settings `GET` floor from a rank check to requiring `settings.manage` or `billing.manage` explicitly.
- Replaced rank-based gates on activity, member-detail, SSO/domain, webhook and Stream-roster reads with the matrix's named keys, closing several cases where a numerically high rank (BILLING_ADMIN) had incidentally passed a gate meant for operational roles.
- Scoped the data-export read and download paths by the request's `OrgDataExportKind` rather than returning the full bundle regardless of who asked.
- Split the audit feed into `audit.read.ops` and `audit.read.money`, so a SUPPORT role holding only the ops grant stops receiving amount fields in the same response that carries its ticket-relevant rows.

## Consequences

### Positive

- The nine known "tab shown, page redirects, API 403s" drift cases the 2026-07 role audit had found are closed, and the shared map makes that kind of drift less likely: the sidebar, the page guard, and the API route all read the same `ORG_PERMISSIONS` map, so their role answers change together whenever the matrix is edited. The map does not by itself keep them aligned, because each consumer still combines it with its own capability checks, and the #1860 route pin is what catches a handler that stops reading it.
- SUPPORT can now do its job (see appointments and members across the whole org for triage) without ever receiving a money figure in the response payload, closing a real information-exposure gap rather than a cosmetic one.
- BILLING_ADMIN, MANAGER and EXPERT each get exactly the surface their job needs, rather than inheriting whatever a numeric rank happened to unlock.

### Negative

- The matrix is now the thing that must be updated whenever a new organization surface ships; a surface added without a matrix entry has no defined access and will fail closed rather than open, which is deliberately safe but does mean a missed matrix entry shows up as a bug report ("I can't see X") rather than a security finding.
- Mobile-specific, role-aware tab sets that a dedicated agent recommended for BILLING_ADMIN, SUPPORT and EXPERT were not built in this round, because desktop was prioritised; this is tracked in issue #1845.

## References

- #1527 — the audit that first proposed a role × page matrix for the organization dashboard.
- PR #1842 — the implementation and the API-level fixes this round closed.
- `lib/auth/org-permissions.ts` — the matrix itself, including its own in-file rationale for using named tiers over rank comparisons.
- `docs/decisions/2026-09-27-backoffice-single-tree-and-capability.md` — the equivalent capability-matrix approach applied to the back office.

## Addendum (2026-09-28): every org route on an action-level matrix (#1860)

PR #1860 closed #1851 and extended this decision in three ways, and this addendum records them rather than opening a new ADR.

First, the matrix now keys actions as well as surfaces. Verbs whose roles differ from their surface's have their own keys, such as `payouts.approve`, `webhooks.subscribe.memberEvents`, `materials.manage.orgPlan`, `members.role.grant.operational`, `members.role.grant.governance`, `programs.seat.period`, `settings.cancellationPolicy.publish` and `identity.manage`, and `memberContent.delete` deliberately holds no role. Every handler under `app/api/organizations/**` now names a matrix key, the rank helpers that routes used to call are deleted, and a jest pin (`__tests__/enterprise/org-route-matrix-pin.test.ts`) fails on any rank check or on any handler without a key. Each retired rank gate was mapped to a key holding exactly the roles it resolved to, so nothing widened by accident, and the only role changes came from owner decisions, each of which narrowed access. `ORG_ROLE_RANK` survives only as a display order. The role × action table in [roles and permissions](../enterprise/00-foundations/04-roles-and-permissions.md) is now generated by `npx tsx scripts/utils/print-org-role-matrix.ts`.

Second, #1851 adopted an ownership principle that sorts records into three classes. Org-owned records follow the matrix, member-owned content is never changeable by org roles and is overseen through metadata only, and members' bookings and seats are reachable only through named, audited verbs. The act-for-org verbs are therefore limited to 1:1 and subscription bookings the org funds, and each writes an `APPOINTMENT_CANCELLED_FOR_ORG` or `APPOINTMENT_RESCHEDULE_REQUESTED_FOR_ORG` row in the MEMBER audit category. The Decision section above was corrected at the same time, because it had said that OWNER alone keeps `programs.manage`, `identity.read` and `appointments.actForOrg.cancel`, while the generated matrix shows that OWNER and MAINTAINER hold all three.

Third, the owner decisions that narrowed access are the following. An org payout batch is paid only after approval under a two-person rule, with a typed self-approval in a one-person org. Only the OWNER subscribes a webhook to `member.*` or `program.assigned` or edits such an endpoint, and a BILLING_ADMIN no longer sees or redelivers those deliveries. A MAINTAINER grants and removes only MANAGER, SUPPORT, EXPERT and LEARNER, and changing a payout recipient is finance-only (#1854). Billing-account edits are audited in the INVOICE category instead of SETTINGS, alongside new money-category rows for funding-source switches, purchase-order edits and deletes, invoice edits and reimbursement exports. An expert's Compensation page shows only the split that applies to them, and the offering editor's Materials tab shows the expert every change the org made to an org-owned plan's files.
