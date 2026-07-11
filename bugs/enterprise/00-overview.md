# Enterprise — Overview

## Context

Familiarise enterprise is Arch 4-Modified: orthogonal **capability** (`canSponsor` / `canHost`), **funding** (PERSONAL/WALLET/INVOICE/LICENSE), and **entitlement** (programs). Platform identity (`UserRole`) is singular; org identity (`Membership` + `MemberRole`) is many. Org-workspace operators create orgs via deferred wizard; RBAC via `requireOrgAccess` + permission matrix. Isolation is application-layer today (no Postgres RLS).

Canonical: `docs/enterprise/`, `ENTERPRISE_SCREENS.html`, `lib/auth/org-permissions.ts`.

## Known gaps / bugs

- Design-partner ready with manual ops; not fully self-serve multi-tenant.
- Host orgs, live payouts, IRP, dunning suspend gated off.
- No RLS; hierarchy columns inert (#771).
- Platform onboarding role race is the sharpest product risk (see sibling file).
- SCIM implemented in code; some docs still say parked.

## Unhappy paths & user psychology

- Buyer expects “enterprise SSO works” while domain claim unverified.
- Two companies fight over the same email domain claim.
- Operator creates org on mobile mid-flight; laptop still on old onboarding role.

## Questions (handled?)

1. **Launch rail: B2B-only first or B2B+B2C together?**  
   - A) B2B design partners only until flags flip  
   - B) Parallel marketplace + enterprise  
   - C) Host orgs later; sponsor orgs first  

**Recommendation: C.** Sponsor-first lets us ship design-partner B2B value without waiting on host-org payouts and 3-way split.  
- Not A: Blocks useful parallel marketplace learning while flags stay off.  
- Not B: Parallel host+sponsor+marketplace spreads eng thin before isolation and payouts are proven.

2. **Is API-layer tenancy enough for customer DPAs?**  
   - A) Yes for design partners  
   - B) RLS required before SOC 2  
   - C) Separate DB per large tenant  

**Recommendation: A.** Document API isolation as sufficient for design partners while scheduling RLS as defense-in-depth.  
- Not B: Blocks partner contracts on work we have not started.  
- Not C: Ops cost is unjustified at current tenant count.

## High concurrency / multi-device

Org money paths (wallet, seats, invites) are well hardened. Platform onboarding is not. See siblings.

## Suggested directions

Treat `ENABLE_HOST_ORGS` + live payouts as a single go-live program, not isolated flags.
