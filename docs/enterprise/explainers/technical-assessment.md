> **⚠️ SUPERSEDED on 2026-04-08.** The canonical enterprise design is being written in PR2 (`feature/enterprise`) as `docs/enterprise/00-canonical-design.md`. This doc's GitHub issue triage (sections 1 and 2) is still useful background reading — several of its recommendations were adopted in PR #647 (AdminLevel drop, shared auth helpers, admin/staff sidebar unification). Its top-line recommendation to defer enterprise work was overridden. Retained for historical context.

# Enterprise & SSO Technical Assessment

> For: Kaustav (Technical Founder)
> Date: 2026-03-23
> Status: Pre-launch research — no code changes recommended yet

---

## Table of Contents

1. [GitHub Issue Triage](#1-github-issue-triage)
2. [Current State Inventory](#2-current-state-inventory)
3. [Schema Placeholder Decision](#3-schema-placeholder-decision)
4. [B2C to B2B Pivot Cost Analysis](#4-b2c-to-b2b-pivot-cost-analysis)
5. [Enterprise vs Non-Enterprise: All 4 Service Types](#5-enterprise-vs-non-enterprise-all-4-service-types)
6. [Recommended Pre-MVP Actions](#6-recommended-pre-mvp-actions)
7. [Risk Matrix](#7-risk-matrix)

---

## 1. GitHub Issue Triage

### #367 — Enterprise Recording Library - B2B Marketplace Expansion

**Verdict: LEGIT vision, OVERENGINEERED for pre-launch**

What's good:
- Correctly identifies the B2B opportunity (companies paying monthly for team access to recordings)
- Solid schema design — `OrgMember` roles (MEMBER, MANAGER, ADMIN, OWNER) map well to real org structures
- Pricing tiers (Team ₹9,999, Business ₹39,999, Enterprise custom) are reasonable for Indian market
- Revenue projection (~24.5L MRR from 100 orgs in Year 1) is optimistic but directionally useful

What's problematic:
- Proposes 12+ new models, 4 implementation phases, 14-19 weeks of work — BEFORE we have a single paying customer
- Mixes "enterprise recording library" with "full org management" — these are separate features with different value propositions
- SSO/SAML is listed as Phase 3 but is the #1 thing enterprise buyers actually ask for
- Revenue projections assume 100 organizations in Year 1 with zero sales team — unrealistic
- The `OrgSize` enum (SMALL/MEDIUM/LARGE/ENTERPRISE) is premature categorization — you won't know how to segment until you have 10+ orgs

**Recommendation**: Keep as the north star roadmap. Do NOT implement any of it pre-launch. The first enterprise deal will be manual/custom anyway — you'll learn what actually matters from that.

---

### #410 — Architecture: Full AWS Migration Plan (Next.js to Spring Boot)

**Verdict: CORRECTLY CLOSED (wontfix)**

What's good:
- Thorough architecture document — Cognito SSO/SAML/OIDC design is production-grade
- Correctly identifies migration triggers: SOC 2, HIPAA, FedRAMP, data residency, 100K+ users
- The Cognito custom attributes (`custom:organizationId`, `custom:orgRole`) show thoughtful design
- Enterprise invitation flow (org admin → SAML → Lambda → User creation) is the right pattern

What's problematic:
- This is a full rewrite from Next.js to Spring Boot + AWS — easily 6+ months of work
- Proposes it as a forward-looking reference, but could mislead someone into thinking it's the plan
- BetterAuth already supports SSO plugins natively — you don't need Cognito for SAML/OIDC

**Recommendation**: Good reference architecture. If you ever need SOC 2 compliance or hit 100K+ MAU, revisit. For the next 12-18 months, BetterAuth's built-in SSO plugin is sufficient.

---

### #326 — Support Multiple Admin Levels (SUPER_ADMIN, ADMIN, MODERATOR)

**Verdict: LEGIT and MVP-ADJACENT**

The `AdminLevel` enum already exists in the Prisma schema at line 2053:

```prisma
enum AdminLevel {
  SUPER_ADMIN // Full system access
  ADMIN       // High-level management
  MODERATOR   // Day-to-day operations
}
```

And `AdminProfile` already has `accessScope Json?` and `assignedRegions String[]`.

What's good:
- The schema is already there — this is about implementing the permission checks in API routes
- Useful for B2C too — you need MODERATOR for day-to-day content moderation, ADMIN for management
- 4-phase roadmap (permission matrix → URL structure → implementation → migration) is sensible

What's problematic:
- For MVP launch, you likely only have 1-2 admins (you + maybe Shubham). Multiple admin levels is useful but not critical.
- The issue doesn't mention enterprise org admins vs platform admins — these are different RBAC domains

**Recommendation**: Implement basic permission checks for `AdminLevel` post-launch when you add your first staff member. Don't conflate platform admin roles with future org admin roles — they're separate hierarchies.

---

### #438 — Invoice System: PDF Generation, Download & Email Delivery

**Verdict: LEGIT PREREQUISITE for both B2C and B2B**

The `Invoice` model already exists in the schema (line 1749) with GST fields (`taxAmount`, `taxRate`, `hsnCode`). What's missing is the PDF generation pipeline and email delivery.

- For B2C: Indian GST compliance requires invoices for all B2B transactions over ₹2.5L/year
- For B2B/Enterprise: Org-level invoicing is table-stakes — enterprises won't pay without proper invoices
- Blocked by: no PDF rendering library, no email delivery for invoices

**Recommendation**: This is genuinely on the critical path. Invoice PDF generation is needed before accepting payments from any Indian business customer, B2C or B2B. Prioritize after core booking flow is stable.

---

### #480 — Production Readiness Audit

**Verdict: TANGENTIAL — SSO mentioned in passing**

Mentions SSO only as a cookie configuration note. Also references Stream.io Enterprise tier (~$800/month) pricing, which is relevant for cost planning but not enterprise features.

**Recommendation**: Track for deployment readiness, not enterprise planning.

---

### #338 — Feature Gap Analysis vs Competitors

**Verdict: TANGENTIAL — no direct enterprise gap identified**

The two-product strategy (Familiarise for mentors, Tiringly for courses) is mentioned but no competitor analysis identifies enterprise/B2B as a gap. TopMate, Preplaced, etc. are all B2C.

**Recommendation**: This actually validates the "B2C first" approach — competitors aren't doing enterprise either, so there's no competitive pressure to rush it.

---

### #484 — Production Scaling: Supabase Limits

**Verdict: MINIMAL RELEVANCE**

Infrastructure scaling discussion. Not relevant to enterprise features.

---

## 2. Current State Inventory

### What's Actually in the Schema (Implemented)

| Model | Lines | Status | Notes |
|-------|-------|--------|-------|
| `Organization` | 375-389 | Schema exists, unused | BetterAuth plugin table. Fields: id, name, slug, logo, metadata |
| `Member` | 391-404 | Schema exists, unused | BetterAuth plugin table. Fields: organizationId, userId, role (string) |
| `Invitation` | 406-420 | Schema exists, unused | BetterAuth plugin table. Fields: organizationId, email, role, status, expiresAt |
| `User.members` | Line 67 | Relation exists | `members Member[]` — connects User to organizations |

These three tables exist because BetterAuth's Organization plugin creates them during schema generation. They are **zero-cost placeholders** — they're in the database but nothing reads or writes to them.

### What's in Design Docs (Not Implemented)

| Document | Location | Scope |
|----------|----------|-------|
| Enterprise Overview | `docs/roadmap/enterprise/README.md` | High-level strategy, implementation order |
| B2B vs B2C Features | `docs/roadmap/enterprise/01-b2b-vs-b2c-features.md` | Feature comparison matrix, pricing tiers |
| Schema Changes | `docs/roadmap/enterprise/02-schema-changes.md` | 12+ new models, enums, migration plan |
| Consultant Companies | `docs/roadmap/features/consultant-companies/README.md` | 1100-line spec: org onboarding, payments, payouts, dashboard |
| BetterAuth Migration | `docs/roadmap/auth/betterauth-migration.md` | NextAuth → BetterAuth decision record |
| BetterAuth Implementation | `docs/roadmap/auth/betterauth-implementation.md` | Plugin configuration, session management |

### What's in Code (Active)

| Component | Status | Notes |
|-----------|--------|-------|
| BetterAuth server | Active | `lib/auth.ts` — email/password + Google/GitHub/Facebook. NO org plugin enabled. |
| Organization API routes | None | No `/api/organizations/*` routes exist |
| Org dashboard pages | None | No `/dashboard/organization/*` pages exist |
| SSO endpoints | None | No SAML/OIDC configuration |
| Enterprise billing | None | No org-level payment flows |

### Gap Summary

```
Schema (exists):     Organization ─── Member ─── Invitation
                          │
Design docs (1100+ lines): OrgSettings, OrgInvoice, RecordingCollection,
                           MemberProgress, OrganizationPlan, PayoutAccount,
                           Payout, OrganizationMember, OrganizationInvitation
                          │
Code (nothing):      ∅ (no routes, no pages, no plugins enabled)
```

---

## 3. Schema Placeholder Decision

### Recommendation: KEEP existing scaffolding. DO NOT add more.

**What to keep (already exists, zero cost):**
- `Organization` model (lines 375-389) — just id, name, slug, logo, metadata
- `Member` model (lines 391-404) — just organizationId, userId, role
- `Invitation` model (lines 406-420) — just organizationId, email, role, status, expiresAt
- `User.members` relation (line 67)

These are BetterAuth's Organization plugin tables. They exist in the schema because BetterAuth generated them. They occupy space in Supabase but no data is written to them. Removing them would break the BetterAuth schema contract for when you eventually enable the plugin.

**What NOT to add pre-MVP:**
- `OrgInvoice`, `OrgSettings`, `RecordingCollection`, `RecordingCollectionItem`, `MemberProgress` (from #367 / `02-schema-changes.md`)
- `OrganizationMember`, `OrganizationInvitation`, `OrganizationPlan`, `PayoutAccount`, `Payout` (from `consultant-companies/README.md`)
- Enterprise-specific enums (`OrgSize`, `EnterprisePlan`, `BillingCycle`, `OrgMemberRole`)

**Why not?**
1. **YAGNI** — You don't have a single enterprise customer yet. The design docs are based on assumptions, not customer feedback.
2. **Schema migration risk** — Every model you add now is a model you have to maintain, migrate, and potentially redesign when real requirements come in.
3. **Two competing designs** — Issue #367 proposes one org schema. `consultant-companies/README.md` proposes a different one. They overlap but conflict on details (e.g., revenue split models, member role enums, payout structures). You'll need to reconcile these when actual enterprise work begins.
4. **BetterAuth plugin handles it** — When you enable the Organization plugin, it manages the core org/member/invitation/team lifecycle. Custom models should be designed to extend BetterAuth's output, not duplicate it.

### One Exception: Consider Adding `organizationId` to `Payment`

The `Payment` model (line 1494) doesn't currently have an `organizationId` field. The design docs recommend adding it as optional:

```prisma
model Payment {
  // ... existing fields ...
  organizationId String?  // Optional: for org-level billing
}
```

This is a safe, additive change (nullable field, no foreign key constraint needed yet). It future-proofs payment records so that if an enterprise customer pays through their organization, you can tag the payment without a schema migration. **But even this can wait** — you can add it when you actually have an enterprise customer, and backfill is trivial.

---

## 4. B2C to B2B Pivot Cost Analysis

If B2C doesn't work and you need to target B2B, here's what changes:

### What Stays the Same (~70% of the app)

| Area | Why It's Identical |
|------|-------------------|
| **Consultant profiles** | A consultant's profile, availability, skills are the same whether they serve individuals or companies |
| **Booking engine** | `SlotOfAppointment`, `Appointment`, scheduling algorithm — identical |
| **Video/Chat (Stream.io)** | Same SDK, same call types, same recording. A webinar is a webinar. |
| **Document review** | `AppointmentDocument` model works the same for B2C and B2B |
| **Plan creation** | `ConsultationPlan`, `SubscriptionPlan`, `WebinarPlan`, `ClassPlan` — same structure |
| **Payment processing** | Stripe/Razorpay checkout — same flow, different payer |
| **Notifications (Novu)** | Same notification types, different recipients |
| **Explore/Discovery** | Consultants listed the same way |

### What Changes (~30% of the app)

| Area | Change Required | Effort | Dependency |
|------|----------------|--------|------------|
| **Auth: SSO** | Enable BetterAuth SSO plugin + provider config UI | 2-3 weeks | BetterAuth Org plugin |
| **Auth: Org plugin** | Enable plugin, add `additionalFields` (plan, seats, billing) | 1 week | None |
| **Org admin dashboard** | 20+ new pages: team management, analytics, billing, settings, branding | 6-8 weeks | Org plugin |
| **Org-level billing** | Invoicing at org level, seat-based pricing, PO support | 3-4 weeks | Invoice PDF (#438) |
| **Revenue splitting** | Platform → Org → Consultant three-way split | 2-3 weeks | Payout system |
| **Custom branding** | Logo, colors, optional custom domain per org | 1-2 weeks | Org plugin |
| **Recording library** | Collections, progress tracking, team access control | 3-4 weeks | Recording system |
| **API access** | REST API with API keys for LMS/HRIS integration | 2-3 weeks | BetterAuth API Key plugin |

**Total estimated pivot cost: ~20-28 weeks of focused engineering work** (one developer).

### Critical Path

```
Enable BetterAuth Org plugin (1 week)
    ├── SSO plugin (2-3 weeks)
    ├── Org admin dashboard (6-8 weeks)
    │       └── Org billing (3-4 weeks)
    │               └── Revenue splitting (2-3 weeks)
    ├── Recording library (3-4 weeks)
    └── API access (2-3 weeks)
```

The org plugin is the foundation — everything else depends on it.

---

## 5. Enterprise vs Non-Enterprise: All 4 Service Types

### Consultations (1:1)

| Aspect | B2C (Current) | B2B (Enterprise) |
|--------|---------------|-----------------|
| **Who books** | Individual consultee | Employee (via org portal or directly) |
| **Who pays** | Individual (Stripe/Razorpay) | Organization (invoice/PO) |
| **Schema change** | None | Optional `organizationId` on Payment |
| **Booking flow** | Identical | Identical — employee books same way |
| **Consultant experience** | Identical | Identical — they see a booked slot |
| **Revenue split** | 80/20 (consultant/platform) | 85/5/10 (consultant/org/platform) |
| **Technical delta** | — | Payment routing + earnings calculation |

**Bottom line**: Almost zero difference in the core experience. The change is who pays and how revenue splits.

### Subscriptions (Recurring 1:1)

| Aspect | B2C (Current) | B2B (Enterprise) |
|--------|---------------|-----------------|
| **Who subscribes** | Individual | Org buys N seats, assigns employees |
| **Who manages renewal** | Individual (auto-renewal) | Org admin (bulk renewal) |
| **Schema change** | None | Seat counter on org, bulk assignment API |
| **Scheduling** | Same | Same — individual employee picks slots |
| **Technical delta** | — | Seat management + org billing + bulk ops |

**Bottom line**: Moderate difference. The seat management and bulk operations are new, but the actual subscription-session-scheduling flow is identical.

### Webinars (1:Many, Single Session)

| Aspect | B2C (Current) | B2B (Enterprise) |
|--------|---------------|-----------------|
| **Who registers** | Individual (checkout) | Org bulk-registers employees |
| **Access control** | Payment = access | Org membership = access (no individual payment) |
| **Max participants** | `WebinarPlan.maxParticipants` (100 default) | Same field, potentially higher limits |
| **Recording access** | Per-session (owned by consultant) | Recording library (curated by org admin) |
| **Schema change** | None for core | `RecordingCollection` + `MemberProgress` for library |
| **Technical delta** | — | Bulk registration API + recording library |

**Bottom line**: The webinar itself is identical. The difference is how people get access (org membership vs individual payment) and what happens to the recording afterward (personal vs library).

### Classes (1:Many, Multi-Session)

| Aspect | B2C (Current) | B2B (Enterprise) |
|--------|---------------|-----------------|
| **Who enrolls** | Individual (checkout) | Org enrolls cohort of employees |
| **Cohort management** | Waitlist + manual | Org admin assigns seats from pool |
| **Scheduling** | `schedulingPeriodStartsAt/EndsAt` | Same — might be customized per org |
| **Progress tracking** | None currently | `MemberProgress` per employee |
| **Certificates** | `certificateProvided` flag exists | Same, possibly org-branded |
| **Technical delta** | — | Cohort management + progress tracking + org branding |

**Bottom line**: Classes have the most enterprise delta because of cohort management and progress tracking. But the core class-session-slot model is identical. The new work is the admin layer on top.

### Summary: What Actually Changes Per Service Type

```
Consultations:  [========..] 80% same — just payment routing changes
Subscriptions:  [=======...] 70% same — add seat management
Webinars:       [=======...] 70% same — add bulk access + recording library
Classes:        [======....] 60% same — add cohort management + progress tracking
```

---

## 6. Recommended Pre-MVP Actions

### Action 1: Keep Existing Schema Scaffolding (Do Nothing)

The `Organization`, `Member`, `Invitation` models already exist. Don't remove them (they're part of BetterAuth's contract), don't add to them. Zero effort.

### Action 2: Do NOT Enable BetterAuth Organization Plugin Yet

The plugin adds runtime behavior (org creation, member management, invitation flows) that you don't need and can't test without real enterprise users. Enabling it prematurely means maintaining code paths that no one uses.

### Action 3: Implement Invoice PDF Generation (#438)

This is genuinely needed for both B2C (Indian GST compliance when you register the business) and B2B (enterprises need proper invoices). It's on the critical path regardless of your B2C/B2B strategy. The `Invoice` model already exists — you need the PDF rendering and email delivery.

### Action 4: Design Your Schema with Optional `organizationId` in Mind

When building new features, consider: "Could this be org-scoped later?" If yes, use patterns that are easy to extend:

```typescript
// GOOD: Easy to add org scope later
const payments = await prisma.payment.findMany({
  where: { userId: session.user.id }
})

// BAD: Hardcoded to individual, painful to extend
const payments = await getPaymentsForIndividualUser(userId)
```

You don't need to add the field now — just avoid patterns that make it hard to add later.

---

## 7. Risk Matrix

### If We Delay Enterprise (Recommended)

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Enterprise customer shows up and we can't serve them | Low (pre-launch) | Medium | Manual onboarding, custom pricing. First 3-5 enterprise deals are always manual anyway. |
| Competitor launches enterprise features first | Very Low (no competitor is doing this) | Low | TopMate, Preplaced are all B2C. No competitive pressure. |
| Schema redesign needed when we do build it | Medium | Low | All planned changes are additive (nullable fields, new tables). No breaking migrations. |
| Design docs become stale | Medium | Low | Docs are directional, not spec. Real requirements come from actual enterprise customers. |

### If We Build Enterprise Now (Not Recommended)

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| 20-28 weeks of engineering on features no one uses | High | High | None — this is pure waste if B2C works |
| Design assumptions are wrong (no customer feedback) | High | High | You'd have to redesign anyway |
| Complexity slows down B2C feature development | High | Medium | Every feature now has to consider org scope |
| Stream.io costs jump (enterprise tier ~$800/month) | Medium | Medium | Only triggered by enterprise usage patterns |
| BetterAuth org plugin introduces bugs in auth flow | Medium | High | Untested code path in production |

### Bottom Line

**The cost of delay is low and recoverable. The cost of premature enterprise build is high and wasteful.**

Your first enterprise deal (probably a college or training institute) will be manual. You'll learn what they actually need. Then you build. The design docs and schema scaffolding you already have give you a massive head start when that time comes.

---

## Appendix: File References

| File | What It Contains |
|------|-----------------|
| `prisma/schema.prisma:375-420` | Organization, Member, Invitation models |
| `prisma/schema.prisma:983-1097` | WebinarPlan, Webinar, ClassPlan, Class models |
| `prisma/schema.prisma:1438-1482` | Recording model |
| `prisma/schema.prisma:1494-1535` | Payment model |
| `prisma/schema.prisma:1749-1774` | Invoice model |
| `lib/auth.ts` | BetterAuth configuration (no org plugin) |
| `docs/roadmap/enterprise/` | Enterprise planning docs |
| `docs/roadmap/features/consultant-companies/README.md` | 1100-line B2B spec |
| `docs/roadmap/auth/betterauth-migration.md` | Auth migration decision |
