# Issue Triage & PR Roadmap

> Generated: 2026-03-16 | Open issues: 83 → 61 after triage (22 closed) | Deployment: Netlify (primary)

---

## 1. Issues to Close (19 issues)

These are already resolved, stale, duplicate, or have no actionable code work.

| # | Title | Reason |
|---|-------|--------|
| 451 | Booking algorithm bug (Codex pt1) | Fixed by PR #441 (17 booking fixes) + PR #404 (334 tests) + 6 E2E agent rounds |
| 452 | Booking algorithm bug (Codex pt2) | Same as above |
| 453 | Booking algorithm bug (Codex pt3) | Same as above |
| 465 | Weekly availability UTC alignment | Fixed by PR #462 — DateTime→Int migration + distributed lock |
| 393 | TrialScheduleCalendar moved | Component deprecated during dashboard redesign |
| 331 | MVP Launch Roadmap tracker | Meta tracker — no code action. Superseded by this document |
| 328 | MVP Launch Pending Items | Meta tracker — superseded |
| 340 | Scale readiness assessment | Planning-only. Docs exist at `docs/competition/` and `docs/deployment/` |
| 338 | Feature gap analysis | Docs exist at `docs/competition/` with threat matrix, battlecard, and per-competitor deep dives |
| 336 | `![security-critical]` (malformed title) | Placeholder/accidental creation |
| 358 | Recordings API perf from PR #357 | PR #357 was reverted (branch `revert-357`). Issue is moot. Recording perf tracked in #360 |
| 410 | AWS Migration Plan | Already labeled "wontfix". Staying on Netlify/Vercel |
| 294 | Race condition web/mobile backends | No mobile app exists or is planned near-term |
| 380 | Referral system & affiliate | Duplicate of #437 (which has full spec + assigned to @shubham79a) |
| 29 | Out of schedule workflow | Superseded by booking algorithm overhaul (PR #404, #441, #462) |
| 31 | Replace CUIDs with UUIDs | Wontfix — mixed cuid/uuid works fine with Prisma 7. New models use uuid() by convention |
| 299 | Schema architecture suggestions | Stale — many schema migrations since Dec 2025, 60+ models now |
| 267 | Payment analytics dashboard | Admin payments page exists. Remaining payment work tracked in #456 |
| 268 | Payment reconciliation | 7+ reconciliation cron jobs exist in `.github/workflows/`. Remaining work tracked in #456 |
| 373 | Research: Scheduling Alternatives | Research doc, not code. Preserved at `docs/research/scheduling-infrastructure-alternatives.md` |
| 446 | Architecture Review | Review doc, not single issue. Preserved at `docs/architecture/architecture-review-2026-02.md` |
| 484 | Production Scaling Roadmap | Planning doc. Preserved at `docs/infrastructure/production-scaling-roadmap.md` |

**Verify before closing** (check if remaining items exist):
| # | Title | Verification |
|---|-------|-------------|
| 269 | Payment gateway improvements | Check against PR #423 (payment audit fixes) and PR #430 (referral + collab revenue) |
| 270 | Service Factory Pattern for Payments | Check if payment abstraction was done in PR #423 or #454 (utils consolidation) |

---

## 2. Triage Matrix

### Legend
- **Verdict**: QUICK-WIN / FOUNDER-REVIEW / INFRA / EXTERNAL / UX-AUDIT / DEFERRED
- **Effort**: S (<4h) / M (4h-2d) / L (2-5d) / XL (5d+)
- **Phase**: P0 (week 1) / P1 (weeks 2-3) / P2 (weeks 4-6) / P3 (launch prep) / P4 (post-launch)
- **Reviewer**: INTERN / FOUNDER / BOTH

### P0 — Critical (7 issues)

| # | Title | Verdict | Effort | Reviewer | Branch Name | Dependencies |
|---|-------|---------|--------|----------|-------------|-------------|
| 480 | Production readiness audit (3 Netlify showstoppers) | FOUNDER-REVIEW | L | FOUNDER | `fix/480-netlify-prod-readiness` | None — read audit first, then decide blockers |
| 488 | Subscription cancellation flow | FOUNDER-REVIEW | L | FOUNDER | `fix/488-subscription-cancellation` | None — launch blocker for money flow |
| 425 | Unsafe deletion of events/plans | FOUNDER-REVIEW | M | FOUNDER | `fix/425-safe-event-deletion` | None — data loss risk |
| 456 | Payment marketplace audit | FOUNDER-REVIEW | L | FOUNDER | `fix/456-payment-audit-fixes` | After #488 (touches same payment files) |
| 401 | Set global Prisma transaction timeout | QUICK-WIN | S | INTERN | `infra/401-prisma-timeout` | None — single config in `lib/prisma.ts` |
| 433 | Currency unit issue | QUICK-WIN | S | INTERN | `fix/433-currency-unit-display` | None — `utils/formatting.ts` |
| 485 | Price on cards + chronological grouping | QUICK-WIN | S | INTERN | `ui/485-price-on-cards` | None — explore page UI only |

### P1 — Lock Down (15 issues)

| # | Title | Verdict | Effort | Reviewer | Branch Name | Dependencies |
|---|-------|---------|--------|----------|-------------|-------------|
| 449 | Reschedule flow bugs + security | FOUNDER-REVIEW | M | BOTH | `fix/449-reschedule-security` | None |
| 448 | Reschedule notifications + audit trail | FOUNDER-REVIEW | M | BOTH | `fix/448-reschedule-notifications` | After #449 (same file area) |
| 400 | Stream Chat security vulnerabilities | FOUNDER-REVIEW | M | FOUNDER | `security/400-stream-chat-hardening` | None |
| 407 | Rate limiting strategy for Netlify | FOUNDER-REVIEW | M | BOTH | `security/407-rate-limiting` | None (enhances existing edge rate limiting) |
| 405 | User lifecycle (deletion, recreation, spam) | FOUNDER-REVIEW | L | FOUNDER | `fix/405-user-lifecycle` | None |
| 300 | In-app notification system | QUICK-WIN | M | INTERN | `feat/300-novu-in-app-notifications` | None (Novu already integrated) |
| 337 | Email notifications for reschedule | QUICK-WIN | M | INTERN | `feat/337-reschedule-emails` | None (Resend already integrated) |
| 274 | Extract shared dashboard components | QUICK-WIN | M | INTERN | `refactor/274-shared-dashboard-components` | None |
| 251 | Standardize checkout route params | QUICK-WIN | M | INTERN | `refactor/251-checkout-route-params` | None (rename only) |
| 468 | Cookie & notification preferences persistence | QUICK-WIN | M | INTERN | `feat/468-cookie-notification-prefs` | None |
| 381 | Advanced cookie consent features | QUICK-WIN | S | INTERN | `feat/381-advanced-cookie-consent` | After #468 |
| 476 | Distributed locking for cron jobs | INFRA | M | BOTH | `infra/476-cron-distributed-lock` | None |
| 481 | Billing guardrails (prevent surprise bills) | INFRA | S | FOUNDER | `infra/481-billing-guardrails` | None |
| 378 | PostHog analytics + Sentry error tracking | EXTERNAL | M | INTERN | `feat/378-posthog-sentry` | Sentry + PostHog accounts |
| 475 | Sentry error tracking (merge with #378) | EXTERNAL | - | - | Merged into #378 PR | — |

### P2 — Polish (18 issues)

| # | Title | Verdict | Effort | Reviewer | Branch Name | Dependencies |
|---|-------|---------|--------|----------|-------------|-------------|
| 440 | DB exclusion constraint for slot overlap | FOUNDER-REVIEW | M | FOUNDER | `fix/440-db-exclusion-constraint` | None (raw SQL migration) |
| 469 | Google One Tap sign-in | EXTERNAL | M | BOTH | `feat/469-google-one-tap` | Existing Google OAuth in BetterAuth |
| 334 | ConvertKit newsletter | EXTERNAL | S | INTERN | `feat/334-convertkit-newsletter` | ConvertKit account. Route has `TODO: Issue #334` |
| 487 | Consultant dashboard audit (14 pages) | UX-AUDIT | XL | BOTH | Decompose into per-page PRs: `ui/487-{page-name}` | After #274 |
| 486 | Consultee dashboard audit (8 tabs) | UX-AUDIT | L | BOTH | Decompose into per-tab PRs: `ui/486-{tab-name}` | After #274 |
| 445 | Consultee appointments tab UX | UX-AUDIT | M | INTERN | `ui/445-consultee-appointments-ux` | Subset of #486 |
| 450 | Performance: landing, explore, detail pages | UX-AUDIT | L | BOTH | `perf/450-page-load-optimization` | None |
| 309 | Slot availability API optimization | QUICK-WIN | M | INTERN | `perf/309-slot-api-caching` | None |
| 383 | Database query performance optimization | QUICK-WIN | M | BOTH | `perf/383-db-query-optimization` | Profile after deploy |
| 474 | Critical email retry with dead-letter queue | INFRA | M | BOTH | `infra/474-email-retry-dlq` | None |
| 473 | Stream.io circuit breaker | INFRA | M | INTERN | `infra/473-stream-circuit-breaker` | None |
| 472 | Session overrun detection | INFRA | M | INTERN | `infra/472-session-overrun-detection` | None |
| 471 | No-show detection and handling | INFRA | M | INTERN | `infra/471-no-show-detection` | None |
| 368 | Prisma connection pool exhaustion | INFRA | M | BOTH | `fix/368-prisma-pool-config` | None (already using PrismaPg adapter) |
| 308 | Seed data consistency | QUICK-WIN | M | INTERN | `fix/308-seed-data-consistency` | None |
| 279 | Subscription reschedule support | QUICK-WIN | M | BOTH | `feat/279-subscription-reschedule` | After #488 |
| 386 | LinkedIn URL redundancy fix | QUICK-WIN | S | INTERN | `fix/386-linkedin-url-redundancy` | Schema migration |
| ~~484~~ | ~~Production scaling roadmap~~ | CLOSED | - | - | Moved to `docs/infrastructure/production-scaling-roadmap.md` | — |

### P3 — Launch Prep (8 issues)

| # | Title | Verdict | Effort | Reviewer | Branch Name | Dependencies |
|---|-------|---------|--------|----------|-------------|-------------|
| 437 | Referral system UI completion | DEFERRED | L | BOTH | `feat/437-referral-ui` | Schema + API already exist |
| 438 | Invoice system (PDF + email) | DEFERRED | L | BOTH | `feat/438-invoice-pdf-generation` | Invoice model + API exist |
| 341 | Send inquiry feature | DEFERRED | M | INTERN | `feat/341-send-inquiry` | None |
| 379 | Consultant verification gate | DEFERRED | M | FOUNDER | `feat/379-consultant-verification` | After #405 (user lifecycle) |
| 377 | Intercom chat widget | EXTERNAL | S | INTERN | `feat/377-intercom-widget` | Intercom account ($74/mo or Crisp $25) |
| 409 | Aikido Security scanning | EXTERNAL | S | INTERN | `infra/409-aikido-security` | GitHub App install (free) |
| 387 | Staff onboarding validation workflow | DEFERRED | M | BOTH | `feat/387-staff-onboarding` | None |
| 399 | Novu webhook receiver for delivery tracking | DEFERRED | M | INTERN | `feat/399-novu-webhook-receiver` | After #300 |

### P4 — Post-Launch (14 issues)

| # | Title | Verdict | Effort | Reviewer |
|---|-------|---------|--------|----------|
| 367 | Enterprise recording library | DEFERRED | XL | FOUNDER |
| 366 | Recording monetization | DEFERRED | L | FOUNDER |
| 360 | Recording storage strategy | DEFERRED | M | BOTH |
| 342 | Stream Chat SDK feature roadmap | DEFERRED | L | BOTH |
| 326 | Multiple admin levels | DEFERRED | M | FOUNDER |
| 312 | Directus CMS for blog | EXTERNAL | L | BOTH |
| 371 | AI recommendation system | EXTERNAL | XL | FOUNDER |
| 373 | Scheduling infrastructure alternatives | DEFERRED | - | FOUNDER |
| 347 | Bulk document review | DEFERRED | M | INTERN |
| 348 | Real-time document updates | DEFERRED | L | BOTH |
| ~~446~~ | ~~Architecture review (full)~~ | CLOSED | - | Moved to `docs/architecture/architecture-review-2026-02.md` |
| 470 | Supabase storage UUID naming convention | DEFERRED | M | BOTH |
| 248 | Stream Chat sync on dashboard load | DEFERRED | M | INTERN |
| 409 | Aikido Security (if not done in P3) | EXTERNAL | S | INTERN |

---

## 3. Phase Plan

### Phase 0 — "Stop the Bleeding" (Week 1)

**Goal**: Close dead issues, fix money-touching bugs, prevent data loss.

```
Day 1:  Close 19 dead issues (30 min batch operation)
        Ship #401 (prisma timeout — one config line)
        Ship #433 (currency unit — utils/formatting.ts)
        Ship #485 (price on cards — UI only)

Day 2-3: #480 — Read production readiness audit, decide which of the 3
         Netlify showstoppers need code. Key findings:
         - Permissions-Policy blocks camera/mic (Stream.io calls break)
         - Netlify function timeout risks for payment webhooks
         - Missing Netlify Next.js plugin

Day 3-5: #488 — Subscription cancellation flow
         Schema has CancellationReason enum + cancelledAt/cancelledBy fields
         Missing: cancellation API endpoint, refund initiation, audit logging
         Files: app/api/events/subscriptions/, lib/payments/

Day 5-7: #425 — Unsafe deletion guard
         Planner services have deleteEvent/deleteWebinar with no soft-delete
         or payment refund checks
         Files: planner/services/ (webinar, class, consultation, subscription)
```

### Phase 1 — "Lock Down" (Weeks 2-3)

**Goal**: Security hardening, notification completeness, quick refactors.

```
LANE A (Founder):     #456 → #449+#448 → #405
LANE B (Intern 1):    #274 → #433 → #251 → #445
LANE C (Intern 2/AI): #476 → #378 → #468+#381
LANE D (Intern):      #300 → #337
Standalone:           #400, #407, #481 (founder reviews when ready)
```

### Phase 2 — "Polish" (Weeks 4-6)

**Goal**: Performance, UX, remaining infrastructure.

```
UX Audits:    Decompose #487 (14 pages) and #486 (8 tabs) into
              individual PRs. #445 is a subset of #486.
Performance:  #450 → #309 → #383 (profile, then optimize)
Infra:        #474, #473, #471, #472, #368
Features:     #469 (Google One Tap), #334 (ConvertKit)
Data:         #440 (DB constraint), #308 (seeds), #386 (LinkedIn fix)
Depends:      #279 (subscription reschedule) — only after #488 lands
```

### Phase 3 — "Launch Prep" (Week 7)

**Goal**: Final features, external services, soft launch.

```
Features: #437 (referral UI), #438 (invoice PDF), #341 (inquiry), #379 (verification)
External: #377 (Intercom/Crisp), #409 (Aikido scan)
Staffing: #387 (staff onboarding validation)
```

### Phase 4 — "Post-Launch" (Month 2+)

Everything deferred. Recordings, enterprise, AI, admin levels, CMS.

---

## 4. Parallel PR Lanes

### Lane Map

```
LANE A — Payments/Booking (FOUNDER)          LANE B — UI/UX (INTERN)
──────────────────────────────────           ─────────────────────────
#488 subscription cancel                     #433 currency unit
  ↓                                          #485 price on cards
#425 unsafe deletion                         #274 shared components
  ↓                                            ↓
#456 payment audit                           #445 appointments UX
  ↓                                            ↓
#449 reschedule bugs                         #487 consultant audit (per-page)
  ↓                                          #486 consultee audit (per-tab)
#448 reschedule notifications

LANE C — Infrastructure (INTERN/AI)          LANE D — Notifications (INTERN)
───────────────────────────────────          ──────────────────────────────
#401 prisma timeout                          #300 in-app notifications
#476 cron distributed lock                   #337 reschedule emails
#378+#475 Sentry + PostHog                   #334 ConvertKit
#468 cookie preferences
  ↓
#381 advanced cookies
```

### Conflict Zones

| File/Directory | Issues That Touch It | Rule |
|---------------|---------------------|------|
| `prisma/schema.prisma` | #386, #440, #405 | ONE migration PR at a time. Rebase others after merge |
| `middleware.ts` | #407, #469 | Sequential — #407 first |
| `lib/payments/operations/checkout.ts` (1984 lines) | #488, #456 | #488 first, then #456 audits the result |
| `app/api/appointments/` | #449, #448 | Same PR or strictly sequential |
| Dashboard components | #274, #487, #486 | #274 (extract shared) merges BEFORE audit PRs |

---

## 5. PR Strategy

### Branch Naming Convention

```
{type}/{issue#}-{short-description}

Types:
  fix/       Bug fixes
  feat/      New features
  refactor/  Code reorganization
  infra/     Infrastructure
  security/  Security fixes
  ui/        UI-only changes
  perf/      Performance
  docs/      Documentation only
  chore/     Maintenance, deps

Examples:
  fix/488-subscription-cancellation
  security/400-stream-chat-token-hardening
  feat/300-novu-in-app-notifications
  refactor/251-checkout-route-params
```

### PR Review Matrix

| PR Type | First Reviewer | Final Approver | Auto-merge? |
|---------|---------------|---------------|-------------|
| UI-only (no API/DB) | Intern | Intern | Yes (after green CI) |
| Refactor (no logic change) | Intern | Intern | Yes |
| API logic change | Intern | Founder | No |
| Payment/money | Founder | Founder | No |
| Auth/security | Founder | Founder | No |
| Schema migration | Founder | Founder | No |
| Infrastructure/cron | Intern first pass | Founder | No |
| External integration | Intern | Founder | No |

### PR Size Guidelines

- **Target**: 100-300 lines changed
- **Maximum**: 500 lines (decompose if larger)
- **UX audits** (#487, #486): MUST decompose into per-page/per-tab PRs
- **Payment audit** (#456): May exceed 500 lines — that's OK for cross-cutting audits

---

## 6. Dependency Graph

```
                    ┌─────────────────────┐
                    │  Phase 0 (no deps)  │
                    └──┬──┬──┬──┬──┬──┬──┘
                       │  │  │  │  │  │
              ┌────────┘  │  │  │  │  └────────┐
              ▼           ▼  ▼  ▼  ▼           ▼
           #401        #433 #485 #425       #480
         (prisma       (currency) (deletion) (audit)
          timeout)         │              │
                          │              │
              ┌───────────┘              │
              ▼                          ▼
   #488 (subscription cancel) ──→ #456 (payment audit)
              │                          │
              ▼                          ▼
   #279 (sub reschedule)        #449 (reschedule bugs)
                                         │
                                         ▼
                                #448 (reschedule notifs)

   #468 (cookie prefs) ──→ #381 (advanced cookies)
   #378 + #475 (merge into single Sentry+PostHog PR)
   #274 (shared components) ──→ #487, #486, #445 (UX audits)
   #405 (user lifecycle) ──→ #379 (verification gate)
   #300 (in-app notifs) ──→ #399 (Novu webhook)
   #450 (performance audit) ──→ #309, #383 (optimization)
```

**Critical path** (founder must do in this order):
1. #480 — Read audit, decide Netlify blockers (2h)
2. #488 — Subscription cancellation (2-3d)
3. #456 — Payment audit sweep (2-3d)
4. #425 — Unsafe deletion guard (1d)
5. #405 — User lifecycle (2-3d)

---

## 7. External Integration Checklist

| Service | Issue(s) | Free Tier | Paid Tier | Env Vars | When |
|---------|----------|-----------|-----------|----------|------|
| Sentry | #378, #475 | 5K errors/mo | $26/mo | `SENTRY_DSN` (already in `.env.sample`) | P1 — create account now |
| PostHog | #378 | 1M events/mo | Usage-based | `NEXT_PUBLIC_POSTHOG_KEY`, `POSTHOG_HOST` | P1 — create account now |
| Google One Tap | #469 | Free | Free | Existing Google OAuth client ID | P2 — just add One Tap script |
| ConvertKit | #334 | 1K subscribers | $29/mo | `CONVERTKIT_API_KEY`, `CONVERTKIT_FORM_ID` | P2 |
| Intercom | #377 | None | $74/mo Starter | `NEXT_PUBLIC_INTERCOM_APP_ID` | P3 (consider Crisp at $25/mo) |
| Aikido | #409 | Free <10 repos | Free for OSS | GitHub App install only | P3 |
| Directus | #312 | Self-host free | Cloud $15/mo | `DIRECTUS_URL`, `DIRECTUS_TOKEN` | P4 |
| AI/ML | #371 | TBD | TBD | TBD | P4 — needs product design first |

**Incremental monthly cost**: P1 adds $0-26, P2 adds $0-29, P3 adds $25-74. Total: $25-129/mo.

**Action now**: Create Sentry + PostHog accounts (5 min each). Env vars for Sentry already exist in `.env.sample`.

---

## 8. Dependabot PR Triage (12 PRs)

### Safe to Merge (low risk — dev deps, types, patches)

| PR | Description | Action |
|----|------------|--------|
| #478 | Build tools bump (3 dev deps) | Merge |
| #443 | TypeScript types bump (2 updates) | Merge |
| #427 | Dev utilities bump (4 updates) | Merge |
| #417 | Axios patch v1.13.3→v1.13.4 | Merge |
| #408 | actions/github-script v7→v8 | Merge |
| #460 | actions/upload-artifact v4→v7 | Merge |

### Review Carefully (production dependencies)

| PR | Description | Risk | Action |
|----|------------|------|--------|
| #491 | Database/Storage group (16 updates!) | HIGH — Prisma/Supabase SDK changes | Review changelogs, test locally |
| #429 | Stream communication (7 updates) | MEDIUM — video/chat SDK | Test video calls in dev |
| #411 | Core framework (5 updates) | MEDIUM — Next.js/React | Test build + key pages |
| #413 | Payment group (2 updates) | MEDIUM — Stripe/Razorpay SDK | Test checkout flow |

### Low Priority (merge when convenient)

| PR | Description | Action |
|----|------------|--------|
| #490 | Email group (4 updates) — Resend/Novu | Merge after #300 (notifications) |
| #426 | Performance (2 updates) | Merge anytime |

---

## 9. What to Do Right Now

### Today (30 minutes)
1. Close the 19 dead issues (automated with comments)
2. Create Sentry + PostHog accounts
3. Assign Lane B + C + D issues to interns in GitHub

### This Week (Phase 0)
1. Intern ships #401 (prisma timeout), #433 (currency), #485 (price on cards)
2. Founder reads #480 audit, decides Netlify blockers
3. Founder starts #488 (subscription cancellation) — single most important gap
4. Merge 6 safe dependabot PRs (#478, #443, #427, #417, #408, #460)

### Next 2 Weeks (Phase 1)
1. Founder: #456 (payment audit) → #449+#448 (reschedule)
2. Intern: #274 (shared components) → #251 (checkout params) → #445 (appointments UX)
3. Intern/AI: #476 (cron locking) → #378 (Sentry+PostHog) → #468 (cookie prefs)
4. Intern: #300 (in-app notifications) → #337 (reschedule emails)
