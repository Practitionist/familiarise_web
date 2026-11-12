# ADR: Bounding subscription sales — sold-but-unplaced plans count at checkout, and an expert-set limit on plan clients

- **Status**: Accepted (owner decisions, 2026-11-13). Decisions 1, 2 and 3 are **built** on the branch that carries this record (`feat/subscription-demand-bounds`). Decision 4 was considered and **not built**.
- **Date**: 2026-11-13
- **Author**: Platform engineering
- **Related**: [Scheduling surfaces and feasibility](2026-11-09-scheduling-surfaces-and-feasibility.md) (decision 6, feasibility before money), [Booking system HLD](../start-here/01-booking-system-hld.md), [Approval payments](../finance/10-money-in/05-approval-payments.md), [Booking schema reference](../booking/21-schema-reference.md), issue [#2742 "Subscriptions: an unpaid request the expert approves before the learner pays (considered 2026-11-13, not built)"](https://github.com/Practitionist/familiarise_web/issues/2742)

## Context

The question was how many subscriptions (multi-week 1:1 plans) an expert can sell before the platform has taken money it cannot deliver on.

A subscription is created only at checkout, by `handleSubscriptionCheckout` (`lib/payments/checkout/handlers/subscription.ts`). It is `PENDING` while it waits for the expert to place its first sessions and `APPROVED` once they do. Before this change the checkout gate (`assessExpertFeasibility` in `lib/booking/feasibility.ts`) counted only sessions that were already placed as busy time. A plan that was paid, or held in a live checkout, but not yet placed counted as nothing. An expert with open hours could therefore sell any number of paid plans, and every plan after the ones the calendar could hold ended in a refund: on the expert's decline, or after 48 hours.

What was verified on `dev` at `534f69b21` before building:

- Feasibility refuses with 409 `NOT_PLACEABLE` only when the buyer's first week holds no session at all (decision 6 of the scheduling ADR). That threshold is unchanged here.
- The pause switch (`acceptingRequests = false`) already refuses checkout with `NOT_ACCEPTING_BOOKINGS`. `ConsultantProfile.maxOpenRequests` limits open requests, not active clients. No column or sidecar recorded a limit on active plan clients.
- The approval pay-link code still had a subscription arm. `calculateAmount` in `lib/payments/operations/approval-payment.ts` priced a subscription from the plan's current price, and three callers led to it: the subscription detail PATCH's link-retry branch, the subscription path of the pay page's re-mint (`lib/payments/pay-page.ts`), and the allocate handler's mint for an unpaid subscription. No live writer moves a subscription to `APPROVED_PENDING_PAYMENT`: the detail PATCH accepts only `APPROVED` and `REJECTED`, the list PATCH only `REJECTED`, and allocation refuses an unpaid plan with `SUBSCRIPTION_UNPAID` instead of parking it. Production held no subscription in that status on 2026-11-13.

## Worked example

Hannah Anderson publishes six one-hour weekly slots, Monday to Saturday 10:00 to 11:00 in Asia/Kolkata, and sells a plan of three one-hour sessions a week. Within one hour, Charlotte Brown, Olivia Anderson and Grace Wilson each buy it.

- **Before.** All three pay. Hannah can place six sessions a week, so only two of the three plans can ever be placed. Grace is refunded when Hannah declines, or after 48 hours.
- **After.** Charlotte's checkout sees six free sessions and nothing sold, so her first week has room for three. Olivia's sees six free sessions less Charlotte's three unplaced ones, so room for three. Grace's sees six less six, so room for none, and checkout refuses her with 409 `NOT_PLACEABLE` before any gateway order is minted. If Charlotte had abandoned her checkout, her hold would have stopped counting when it lapsed, and Grace would have been sold the plan.
- **With the limit.** If Hannah also sets "Limit mentorship plan clients to 2", her plan cards show "Fully booked" once Charlotte and Olivia hold plans, and a checkout reached another way is refused with 409 `PLAN_CLIENTS_FULL`. Charlotte can still renew, because she is already one of Hannah's two clients.

## Decisions

1. **Checkout counts sold-but-unplaced plans** (decided, built).
   - **What counts.** For every other plan of the same expert that holds its buyer, its frozen weekly cadence less the sessions it already has placed in the week being assessed, never more than its unplaced entitlement. A plan holds its buyer when it has a live status (`LIVE_SUBSCRIPTION_STATUSES`) and is not a checkout hold whose payment lapsed (`buildDeadHoldFilter`). An abandoned checkout therefore stops counting the moment its hold expires, with no new timer. Placed sessions are already busy time, so they are never counted twice. A plan counts only in the weeks its own window overlaps.
   - **How it is subtracted.** The unplaced sessions are counted as time: their minutes, in the other plans' own session lengths, are divided by the buyer's session length and subtracted from the number of buyer-length sessions the free time could hold with no per-day cap. The buyer's room in a week is the smallest of their cadence, their one-a-day count and that remainder.
   - **Enforced by** `readUnplacedPlanMinutes` (`lib/booking/plan-demand.ts`) and the `reservedMinutesByWeek` input of `assessFeasibility` (`lib/booking/feasibility.ts`), passed through `assessExpertFeasibility`'s `planDemand` option by `handleSubscriptionCheckout` (409 `NOT_PLACEABLE`, copy unchanged) and by `GET /api/plans/subscriptions/[id]/feasibility`, so the "room for about N of M" notice uses the same number as the refusal.
   - **Serialised.** Checkout takes the expert's `request-cap:<consultantProfileId>` key (`lockExpertPlanSales` in `lib/payments/checkout/locks.ts`) for every plan checkout and holds it across the count and the commit of the buyer's own hold. It sits in the global lock order's consultant tier: after `event-checkout:` and before `consultee-booking:` for a start-date checkout, and before the consultee key and slot batch for a slot checkout. Checkout takes no other consultant-tier key. A held key answers 409 `EVENT_CHECKOUT_BUSY`, which the client retries once.
   - **Every purchase shape.** Organisation-funded, zero-amount and mock checkouts run the same handler under the same key; their payment succeeds in the same commit, so they count as paid at once. A renewal excludes the plan it renews, and its first week starts at that plan's end, so the running plan never blocks it; a renewal sent without a start date now takes the per-expert key too. A "start now" purchase assesses the week from now plus the allocation lead time.

2. **An expert-set limit on active plan clients** (decided, built).
   - **What counts.** Distinct buyers holding one of the expert's plans, with the same "holds its buyer" rule as decision 1. A buyer who already holds a plan with the expert is not a new client: a renewal or a second plan never trips the limit, even after the expert lowers it below the current count.
   - **The column.** `ConsultantProfile.maxActivePlanClients`, a nullable integer; null means no limit. `consultant_profile_max_active_plan_clients_min` in `prisma/sql/check-constraints.sql` keeps a set value at 1 or more. There is no backfill: every expert starts with no limit.
   - **Enforced by** `assertPlanClientRoom` in `handleSubscriptionCheckout`, inside the same serialised section as decision 1, refusing with 409 `PLAN_CLIENTS_FULL` and the copy "This expert's mentorship plans are fully booked right now. Pick another expert, or try again later. You have not been charged." Lowering the limit changes only new purchases; nothing touches a plan already sold.
   - **Storefront.** The expert profile's pricing card and the plan page show "Fully booked" and disable "Start mentorship" from `planClientsFull`, a server-computed flag. The limit itself never leaves the server: the public consultant payloads do not carry it, and only the owner's settings read it.
   - **Setting.** Settings → Booking has "Limit mentorship plan clients to", a whole number from 1 to 500 or blank for no limit, with the current count ("3 of 5 active plan clients") from the owner-only `GET /api/user/consultants/[id]/plan-clients`. The value is saved through the booking-settings PATCH, validated by `maxActivePlanClientsSchema` (`schemas/plan-clients.ts`) and written by the same compare-and-set as the other booking settings.

3. **The dead subscription pay-link arm is deleted** (decided, built). `createApprovalPaymentIntent` and `mintApprovalPaymentAfterCommit` now serve consultations and trials only. The subscription arm of `calculateAmount`, the subscription detail PATCH's link-retry branch, the subscription path of the pay page's re-mint and the allocate handler's subscription mint are gone, and the mint lock's kind no longer names subscriptions. `SETTLED_SUBSCRIPTION`'s free-plan shortcut stays: it is also read by the live approve path and by allocation, not only through the deleted arm.

4. **An unpaid request the expert approves before the learner pays** (considered, **not built**). Recorded as [#2742](https://github.com/Practitionist/familiarise_web/issues/2742), "Subscriptions: an unpaid request the expert approves before the learner pays (considered 2026-11-13, not built)". It would remove refunds after a decline entirely, but it brings back the approval pay-link for plans that decision 3 deletes, and the two bounds above stop the oversell without changing how a plan is paid.

## Honest limits

- **Time, not exact placement.** Decision 1 subtracts unplaced minutes from free time. It ignores fragmentation (two free half hours do not make a one-hour session) and the other plans' own one-a-day caps, and it reads each plan's weekly cadence against the buyer's week, which need not line up with that plan's own plan weeks. It can be wrong by a session in either direction; the threshold stays "refuse only when the first week holds none", so a thin plan still sells with the notice.
- **An abandoned hold still counts until it lapses.** A buyer who abandons a checkout holds room for up to the 30-minute direct-checkout hold (`DIRECT_CHECKOUT_HOLD_MS`).
- **The profile page can lag the limit.** The expert profile page is cached for 5 minutes (`revalidate = 300`) and is purged when the expert saves their settings, but not when a sale fills the limit or a plan ends. "Fully booked" can therefore appear or disappear up to about 5 minutes late there; the plan page is rendered per request and is never stale. Checkout is the authority either way.
- **The flag is not per viewer.** A buyer who already holds a plan with the expert sees "Fully booked" on the storefront even though checkout would let them buy; renewals are offered from their dashboard instead.

## Deprecated & Superseded Approaches

- **Counting only placed sessions at the checkout gate.** Replaced by decision 1; `assessExpertFeasibility` without `planDemand` remains only for the plan editor and the allocate page, which are not sales.
- **Approval pay-links for subscriptions.** Plans have been paid at purchase since the earlier train; decision 3 deletes the code that still minted them. Do not add `SUBSCRIPTION` back to `createApprovalPaymentIntent`.
