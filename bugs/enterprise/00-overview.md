# Enterprise — Overview

## Context

Familiarise enterprise is Arch 4-Modified: orthogonal **capability** (`canSponsor` / `canHost`), **funding** (PERSONAL/WALLET/INVOICE/LICENSE), and **entitlement** (programs). Platform identity (`UserRole`) is singular; org identity (`Membership` + `MemberRole`) is many. Org-workspace operators create orgs via deferred wizard; RBAC via `requireOrgAccess` + permission matrix. Isolation is application-layer today (no Postgres RLS).

Canonical: `docs/enterprise/`, `ENTERPRISE_SCREENS.html`, `lib/auth/org-permissions.ts`.

**Deep-dive pack (second wave):** taxonomy, host agencies, money E2E, compliance gates, concurrency, gaming — listed below.

## Known gaps / bugs

- Design-partner ready with manual ops; not fully self-serve multi-tenant.
- Host orgs, live payouts, IRP, dunning suspend gated off.
- No RLS; hierarchy columns inert (#771).
- Platform onboarding role race is the sharpest identity risk (see sibling file).
- SCIM implemented in code; some docs still say parked.
- **P0 money trust:** checkout↔ledger non-atomicity; PENDING_TRUST mis-scoped to host not sponsor; consultant payables unparked for ghost INVOICE; KYB/domain unwired — see money-* and compliance-* files.

## Deep-dive index

| File | Focus |
|------|--------|
| [taxonomy-and-reachable-paths.md](taxonomy-and-reachable-paths.md) | Done matrix: SPONSOR/HOST/HYBRID × funding × programs |
| [host-agency-product-coverage.md](host-agency-product-coverage.md) | Consult/sub/webinar/class + RateCard + silent split |
| [money-checkout-wallet-invoice.md](money-checkout-wallet-invoice.md) | Org checkout atomicity, wallet, INVOICE, LICENSE |
| [money-refunds-disputes-overage.md](money-refunds-disputes-overage.md) | Cascades, #716, chargebacks, clawback |
| [money-payouts-earnings-trust.md](money-payouts-earnings-trust.md) | PENDING_TRUST, PAID-before-wire, live payouts |
| [compliance-kyb-gst-tds.md](compliance-kyb-gst-tds.md) | KYB/domain, IRP, MSME, GST invoices |
| [concurrency-deadlocks-spikes.md](concurrency-deadlocks-spikes.md) | CAS, SSO LWW, SCIM, chaos 14c |
| [multi-device-gaming-abuse.md](multi-device-gaming-abuse.md) | Seat sharing, ADR-18, invoice ghosting |
| [onboarding-multi-device-role-race.md](onboarding-multi-device-role-race.md) | Dual-role last-write-wins |
| [rbac-tenancy-isolation.md](rbac-tenancy-isolation.md) | RBAC, RLS, EXPERT asymmetry |
| [billing-seats-sso.md](billing-seats-sso.md) | Seats, SSO, auto-top-up |
| [incomplete-and-flags.md](incomplete-and-flags.md) | Feature-flag matrix |

## Unhappy paths & user psychology

- Buyer expects “enterprise SSO works” while domain claim unverified.
- Two companies fight over the same email domain claim.
- Operator creates org on mobile mid-flight; laptop still on old onboarding role.
- Host agency sees earnings UI while flag-off split books marketplace economics only.

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

Org money paths (wallet, seats, invites) are well hardened at the CAS layer. Residual enterprise risk is **trust semantics** (wrong park, PAID-before-wire, KYB) and **governance** (SCIM caps, seat ceilings), plus platform onboarding. See deep-dive files.

## Suggested directions

1. Fix P0 sponsor-trust gates (PENDING_TRUST scope, KYB/domain, checkout↔ledger) before scaling INVOICE.  
2. Treat `ENABLE_HOST_ORGS` + `ENABLE_LIVE_PAYOUTS` as one go-live program.  
3. Stage chaos 14c before enterprise GTM.
