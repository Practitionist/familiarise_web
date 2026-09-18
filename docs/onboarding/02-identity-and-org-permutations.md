---
title: Identity and organisation permutations
band: onboarding
audience: sde1
status: live
last-reviewed: 2026-09-18
---

# Identity and organisation permutations

Three independent choices decide what a signed-in person can do on the platform, and most onboarding defects come from a combination nobody wrote down. This document names the three axes, lists every combination the code allows or refuses today with the code that decides it, and records the one combination that was a dead end until the wizard's add mode landed.

## The three axes

The table below defines the axes and where each is stored.

| Axis                    | Values                                                                            | Stored on                                         | Set by                                                                                                                                                |
| ----------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Platform identity       | `CONSULTANT`, `CONSULTEE`, `ORG_WORKSPACE` (`STAFF` and `ADMIN` are invite-only)  | `User.role`, one value per account                | The wizard's step 0 (`setOnboardingRoleAction` for the org path, `processOnboardingData` otherwise); the add mode can flip `CONSULTEE` → `CONSULTANT` |
| Organisation capability | sponsor only (`canSponsor`), host only (`canHost`), both, neither                 | `Organization.canSponsor`, `Organization.canHost` | `POST /api/organizations`; `canHost` is refused while `ENABLE_HOST_ORGS` is off (`HOST_ORGS_GATED`)                                                   |
| Membership role         | `OWNER`, `MAINTAINER`, `BILLING_ADMIN`, `MANAGER`, `SUPPORT`, `EXPERT`, `LEARNER` | `Membership.role`, one per (user, organisation)   | Invitation accept, admin direct add, SSO JIT                                                                                                          |

`User.role` is exclusive, but a person can hold several profiles: `consultantProfileId`, `consulteeProfileId` and `orgWorkspaceProfileId` are independent links on `User`, and the dashboard router (`app/dashboard/page.tsx`) sends a user to the home of their `role` first, then to whatever `resolvePersonalDashboardHref` finds, then to their highest-ranked organisation (`selectFallbackOrgMembership`, rank then slug).

## Platform identity × membership role

The table below is the matrix the accept route (`app/api/organizations/invitations/accept/route.ts`) and the admin add route (`POST /api/organizations/[orgId]/members`) enforce. "Profile created" names the side effect of accepting.

| `User.role`     | `OWNER` / `MAINTAINER` / `BILLING_ADMIN` / `MANAGER` / `SUPPORT`                                                                                                                             | `EXPERT`                                                                                                                                                                                                                                         | `LEARNER`                                                                                                                                   |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `ORG_WORKSPACE` | Allowed. Both profile links on the membership are cleared (`membership-transitions.ts`). This is the operator's normal state; the first `OWNER` membership is created with the organisation. | Refused with `NOT_A_CONSULTANT` until the account adds an expert profile through the wizard's add mode (`/form/onboarding?add=CONSULTANT`); the invite page links there and the emailed link accepts afterwards. The role stays `ORG_WORKSPACE`. | Allowed; a `ConsulteeProfile` is lazily created (`ensureConsulteeProfile`). Rare, but an operator may learn through their own organisation. |
| `CONSULTANT`    | Allowed by invitation only — `POST /api/organizations` refuses any role but `ORG_WORKSPACE` / `ADMIN`, so a consultant never creates an organisation. `User.role` is not promoted.           | Allowed; the membership links the existing `ConsultantProfile`. Only a `canHost` organisation may invite one (`EXPERT_REQUIRES_CANHOST`).                                                                                                        | Allowed; a `ConsulteeProfile` is lazily created, so a consultant can also learn.                                                            |
| `CONSULTEE`     | Allowed by invitation only, same as above.                                                                                                                                                   | Refused with `NOT_A_CONSULTANT` until the add mode creates the profile; the add mode also flips `User.role` to `CONSULTANT`, so the consultant dashboard becomes home.                                                                           | Allowed; the usual B2B learner. Only a `canSponsor` organisation may invite one (`LEARNER_REQUIRES_CANSPONSOR`).                            |

Two rules sit across the whole table. `EXPERT` and `LEARNER` are disjoint on one membership — a member cannot flip between them; the operator removes and re-invites (`lib/enterprise/role-transitions.ts`). And accept does not re-check the organisation's capability: it trusts the invitation's role, which the invite route checked at issue time, so a capability toggled between issue and accept is not caught (follow-up).

## Organisation capability × membership role

The table below shows which roles an organisation can hold given its capabilities; the invite and admin add routes refuse the others at issue time.

| Capability   | Operator roles | `EXPERT`                       | `LEARNER`                          |
| ------------ | -------------- | ------------------------------ | ---------------------------------- |
| Sponsor only | Yes            | No — `EXPERT_REQUIRES_CANHOST` | Yes                                |
| Host only    | Yes            | Yes                            | No — `LEARNER_REQUIRES_CANSPONSOR` |
| Both         | Yes            | Yes                            | Yes                                |
| Neither      | Yes            | No                             | No                                 |

## Organisation status × what a member can do

An organisation is created `PENDING_VERIFICATION` and an admin moves it through `VERIFY` / `REJECT` / `SUSPEND` / `REACTIVATE` / `DEACTIVATE` with a CAS on the current status (`app/api/admin/organizations/[orgId]/verify/route.ts`). `PENDING_VERIFICATION` gates SSO, invoiced billing and bulk invites, and caps INVOICE-funded checkout at the credit limit; it does not block invitation accept. `SUSPENDED` and `DEACTIVATED` block accept (`isOnboardingBlocked`). A rejected organisation can resubmit from its dashboard (`verification/resubmit`, #779).

## Entry paths that change identity

The table below lists every path that writes `User.role` or a profile link, so a new path can be checked against it.

| Path                                    | Writes                                                                                                           | Guard                                                                                                                         |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `processOnboardingData` (wizard submit) | `role`, the role's profile link; nulls the other three B2C links                                                 | CAS on `onboardingCompleted != true`; email must equal the session's; STAFF/ADMIN refused                                     |
| `setOnboardingRoleAction`               | `role = ORG_WORKSPACE`, creates + links `OrgWorkspaceProfile`                                                    | Self only; allowlist of one role                                                                                              |
| `resetOnboardingRoleAction`             | `role = CONSULTEE`, unlinks the workspace profile                                                                | Only while un-onboarded and with no membership                                                                                |
| `completeOrgWorkspaceOnboardingAction`  | `onboardingCompleted = true`                                                                                     | Requires a live `OWNER` membership                                                                                            |
| `addConsultantIdentity` (add mode)      | Links a new `ConsultantProfile`; `CONSULTEE` → `CONSULTANT`, `ORG_WORKSPACE` unchanged; never nulls another link | Self only; `canAddConsultantIdentity` (onboarded, eligible role, no consultant profile); CAS on `consultantProfileId IS NULL` |
| Invitation accept                       | `Membership` row; lazily a `ConsulteeProfile` for `LEARNER`; never `User.role`                                   | Email match, org not blocked, `NOT_A_CONSULTANT` for `EXPERT` without a profile                                               |
| SSO JIT                                 | `Membership` row and profiles per the provider mapping                                                           | Verified domain claim                                                                                                         |

## Known gaps

The capability re-check at accept time is missing (see above). A user with both a consultant profile and a workspace profile is routed by `User.role` on `/dashboard` but by `resolvePersonalDashboardHref` (workspace first) elsewhere; the two resolvers should be one function. Neither is a launch blocker; both are recorded in the train's tracker issue.
