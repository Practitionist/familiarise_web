---
name: growth
description: Work on this repo's growth subsystem — the newsletter (NewsletterSubscriber, double opt-in, the MARKETING_COMMS consent ledger, signed links, segmented broadcasts), announcements, the appointment waitlist ("Notify me", AppointmentWaitlist), slot backup interest (WindowBackupInterest), the shared interest lifecycle, and referrals (fraud controls, the review hold, the chargeback void). Use when the user says "newsletter", "broadcast", "waitlist", "notify me", "backup interest", "referral", "invite and earn", "announcement", "marketing consent", "growth", or is touching lib/newsletter/, lib/auth/link-signing.ts, lib/booking/event-waitlist.ts, lib/booking/backup-interest.ts, lib/booking/interest/, lib/referrals/, app/api/newsletter/, app/api/admin/newsletter/ or app/api/admin/referrals/.
---

# Growth

Terse rules for agents. The human explanation is in `docs/growth/` (start at `docs/growth/README.md`). The owner's decisions are `docs/decisions/2026-11-08-growth-waitlist-newsletter-referrals.md` (it lands with #2655). Domain detail stays in `docs/email/`, `docs/notifications/`, `docs/booking/`, `docs/referrals/` and `docs/finance/20-ledger/07-referral-credits.md`; link to it, never copy it.

## Vocabulary

Use one word per concept in code, copy and docs.

| Concept                                 | Term                                               | Model                  |
| --------------------------------------- | -------------------------------------------------- | ---------------------- |
| The email list for product news         | newsletter subscribers                             | `NewsletterSubscriber` |
| A learner queued for a sold-out event   | appointment waitlist (the button says "Notify me") | `AppointmentWaitlist`  |
| A learner waiting for a held 1:1 window | slot backup interest                               | `WindowBackupInterest` |

Never write "waitlist" for the newsletter. Never reintroduce `/api/waitlist/*`, `WAITLIST_*`, `EVENT_SOLD_OUT` or `WAITLIST_HMAC_SECRET`.

## Doctrine

1. **Marketing consent has one writer.** Confirm writes a `ConsentArtifact` for `MARKETING_COMMS`; every unsubscribe, complaint and withdrawal withdraws it. Enforcer: `recordNewsletterConsent` and `withdrawNewsletterConsent` in `lib/newsletter/consent-link.ts`. Do not add a second marketing flag.
2. **One lock order for consent withdrawal.** Call `lockNewsletterRows` first, then write `ConsentArtifact`. Enforcer: the helper; every withdrawal path (unsubscribe, Resend webhook, consent route, erasure) already calls it.
3. **Sign links with `signToken` only.** The key derives from `BETTER_AUTH_SECRET` (`lib/auth/link-signing.ts`). Bind a purpose per link, compare with `safeEquals`, and check `canSignLinks()` before any lookup so a signing outage is not a membership oracle. Never add a link secret.
4. **Every email goes through `deliver()`; the broadcast batch calls `heldRecipientDomain()` per recipient.** Enforcer: `EMAIL_DELIVERY_MODE` guard in `lib/email/delivery-guard.ts`.
5. **A broadcast sends at most `BROADCAST_AUDIENCE_LIMIT` (2,000) recipients.** Above it the route answers `422 AUDIENCE_TOO_LARGE`. The next step is the campaign outbox (#2508 "Newsletter system design v1"), not a larger loop.
6. **Announcements and the newsletter stay separate.** An item for both is written once and sent twice. Announcements get no email channel and need no marketing consent. Enforcer: bell policy (`bellAudience`, `lib/novu/policy.ts`).
7. **The waitlist notifies everyone and reserves nothing.** The first to pay wins at the checkout seat gate (`lockEventCheckout` plus the Serializable recount). Do not add a claim window or a queue position without an owner decision.
8. **Stage the notice inside the releasing transaction, finish it after the commit.** `stageSeatOpenedNotices(tx, appointmentId, now)` then `finishSeatOpenedNotices`. Pass a `now` captured outside any retry. Every status change is a compare-and-set `updateMany` with the prior status in `WHERE`.
9. **Both interest tables share `lib/booking/interest/lifecycle.ts`.** 12-hour re-notice (`INTEREST_RENOTIFY_COOLDOWN_MS`), 30-day purge (`INTEREST_RETENTION_MS`), run by the existing `expire-stale-requests` job. Do not add a job or a second lifecycle module.
10. **Capacity override is stored only when it differs from the plan.** Use `capacityOverrideFor(submitted, plan)` in any route that saves an event.
11. **Hosts see counts, never names.** The `demand` view (`prisma/sql/analytics-views.sql`) carries no user id or email.
12. **A referral reward vests only after a paid, delivered session.** Enforcer: `settleQualifyingReferral` in `lib/referrals/vesting.ts`. A credit never exceeds the platform's take on the order it pays for.
13. **Fraud thresholds are configuration, not constants.** The hold rules are fields on `ReferralProgramConfig`; their values are kept in Notion. Never hard-code a threshold, a budget or a vendor cost.
14. **A lost chargeback voids the unspent credit through `reverseCreditBalance`** in the dispute transaction (`settleLostDispute`). Do not add a negative balance.
15. **Money columns are `BigInt` paise; credit and status writes are CAS-in-WHERE** (see `lib/payments/AGENTS.md`).
16. **Stack levers by the one-order pipeline.** A referral welcome discount and a discount code never apply together (`deriveCheckoutAmount()` drops the welcome discount when a code is present), and credits are spent after tax under the same take-rate cap. Read `docs/pricing/01-one-order-pipeline.md` before changing a promo, a credit cap or a fee waiver.

## Confidentiality

Growth follows the general repo-versus-Notion rule (root `README.md`, section "Repo versus Notion"; applied in `.claude/skills/documentation/SKILL.md`). For growth, the repository holds mechanisms, invariants, configuration field names and on-screen terms. The Notion section "Familiarise / Growth & Marketing" holds the referral budget, fraud and hold thresholds, vendor costs and plan choices, growth targets, competitor research and conversion read-outs. Write "set by the owner; the value is kept in Notion (Familiarise / Growth & Marketing)" instead of the value. Vendor plan limits from a public pricing page are allowed.

## Where things live

| Concern                        | Path                                                                                                                               |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| Newsletter service and consent | `lib/newsletter/service.ts`, `lib/newsletter/consent-link.ts`, `lib/newsletter/tokens.ts`, `lib/newsletter/notice.ts`              |
| Broadcast                      | `app/api/admin/newsletter/broadcast/route.ts`, `lib/newsletter/broadcast-audience.ts`, `components/admin/NewsletterManagement.tsx` |
| Public newsletter routes       | `app/api/newsletter/route.ts`, `app/api/newsletter/confirm/route.ts`, `app/api/newsletter/unsubscribe/route.ts`                    |
| Appointment waitlist           | `lib/booking/event-waitlist.ts`, `app/api/scheduling/event-waitlist/route.ts`                                                      |
| Slot backup interest           | `lib/booking/backup-interest.ts`                                                                                                   |
| Shared lifecycle and keys      | `lib/booking/interest/lifecycle.ts`, `lib/booking/interest/query-keys.ts`, `schemas/interest.ts`                                   |
| Capacity                       | `lib/events/capacity.ts`                                                                                                           |
| Host counts and learner list   | `lib/offerings/stats.ts`, `components/booking/WaitingCountBadge.tsx`, `components/appointments/consultee/MyAlerts.tsx`             |
| Referrals                      | `lib/referrals/**`, `app/api/referrals/**`, `app/api/admin/referrals/**`                                                           |
| Sweep for expiry and purge     | `scripts/appointments/expire-stale-requests.ts`                                                                                    |

## Common tasks

**Add a broadcast segment.**

1. Add the field to `broadcastAudienceSchema` in `lib/newsletter/broadcast-audience.ts`.
2. Apply it in `audienceWhere` (or `roleWhere`) in `lib/newsletter/service.ts`, so the preview and the send share one filter.
3. Add the control to `components/admin/NewsletterManagement.tsx`; the send buttons stay off until a preview of the same filters has settled (`settledSendable`).
4. Add a case to `__tests__/newsletter/broadcast-audience.test.ts`.
5. Update the segments paragraph in `docs/growth/02-newsletter-and-announcements.md`.

**Add a release path for the waitlist.**

1. Find the transaction that frees the seat.
2. Inside it, call `stageSeatOpenedNotices(tx, appointmentId, now)` with a `now` captured before the retry loop.
3. After the commit, call `finishSeatOpenedNotices(result)`; never inside the transaction.
4. For a one-to-one window, use `stageNoticesForAppointmentHolds` or `stageNoticesForFreedWindows` from `lib/booking/backup-interest.ts` instead.
5. Add a test in `__tests__/booking/event-waitlist.test.ts` and a row to the release-paths table in `docs/growth/01-appointment-waitlist-and-backup-interest.md`.

**Add a referral signal.**

1. Store it as a keyed hash (`hashSignal` in `lib/referrals/signal-hash.ts`); never store the raw value.
2. Read it in `reviewHoldReason` or the void checks of `lib/referrals/vesting.ts`.
3. Put any threshold on `ReferralProgramConfig` as a nullable field (null means off) and edit it through `PATCH /api/admin/referrals/config` with a reason; the value goes in Notion.
4. Add a case to `__tests__/referrals/referral-fraud-controls.test.ts`.
5. Update `docs/referrals/01-architecture.md` and the control table in `docs/growth/03-referrals.md`.

## Verification

```bash
npx tsc --noEmit
npx jest __tests__/newsletter __tests__/growth __tests__/booking/event-waitlist.test.ts __tests__/booking-algorithm/backup-interest.test.ts __tests__/referrals
npm run lint
rg -n "waitlist" app/api lib emails            # must show only the appointment waitlist
rg -n "WAITLIST_HMAC_SECRET" .                 # must find nothing outside the decision record and deprecated sections
```

The owner runs the schema rename and `npm run db:sidecars` (which recreates the `demand` view); never run them. Docs: `.claude/skills/documentation/SKILL.md`.

## Related skills

`booking` (CAS, locks, the seat gate), `notifications` (bells and email), `finance` (credits and the ledger), `compliance` (DPDP and erasure), `go-live` (the owner steps).
