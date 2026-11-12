# 04-h · Subscriptions: plan end, renewal and an expert who runs out of time

**Needs:** purchases from 04-c; owner-approved clock shifts; background jobs for the `[sweep]` cases (`auto-complete-appointments`, `settle-cancelled-sessions`, `retry-auto-refunds`, `expire-stale-requests`). On a preview the jobs answer 409 `JOB_RUN_PRODUCTION_ONLY`: set the precondition, then mark **NEEDS-OWNER-RUN** with the job name and the verification SQL given here. 12 (`SW-`) owns sweep depth (batching, retries, checkpoints).
**Personas:** B2 (London), B3 (LA), B1 (IST), H1 (IST), H2 (IST), ST.
**Docs under test:** `scripts/appointments/settle-cancelled-sessions.ts` (plan-end pass, `planEndMarker`), `scripts/appointments/expire-stale-requests.ts` (48 h and 30-day arms), `lib/dashboard/money-state.ts` (`planEndedShortWhy`), `lib/payments/checkout/renewal.ts`, decision 9 and "Not built" in the scheduling ADR.

## SU-78 — Plan end with sessions never held: pro-rata refund [sweep] [local]

**Why it matters:** the checkout notice promised "Sessions that can't be scheduled before the plan ends are refunded."

**Setup:** B2's `qa-SU-14` plan (SU-45: 2 or 3 sessions placed, the rest never). Owner-approved: move every placed session into the past and mark it `COMPLETED`, then set `planEndsAt` to 1 hour ago (and `schedulingPeriodStartsAt` back by the same shift). Record D = delivered sessions, T = `sessionsTotal` (12), P = `Payment.amount`, R = refunds already on the payment.

**Steps:**

1. Before any job runs, as B2 and as H2, open the booking.
2. Run (or ask the owner to run) `settle-cancelled-sessions`, then `retry-auto-refunds` if the refund didn't land inline.
3. Reopen both views.

**Expect:**

- Step 1 (plan ended, not settled): the state line reads "Plan ended · <T − D> sessions were not held." The allocate heading reads "Plan ended on <last day> · <D> of 12 booked". Clicking **Auto-schedule this week** now → 400 with `errorCode: "PERIOD_ENDED"`, "This plan's scheduling period has ended, so no more sessions can be placed. Sessions that were never held are refunded when the plan settles." (A manual replay may answer with the plan-week copy instead; record it.)
- After the job: `Subscription.status = COMPLETED` (history reason `PLAN_ENDED`); `Payment.refundOwedKey = plan-end:<sid>:pay:<pid>` stamped, then cleared when the refund lands; refund = min(⌊P × (T − D) ÷ T⌋ − R, refundable balance). Example: P = 150000, T = 12, D = 2, R = 0 → ₹1,250.00.
- State line after: "Plan ended · 10 sessions were not held. ₹1,250 refunded." (or "… refund on its way." while `PENDING`).

**Verification SQL (NEEDS-OWNER-RUN):** R-06 for the plan; R-04 for the placeholder appointment (`refundOwedKey`, the `Refund` row, earnings `refundedShareAmount`).

**Cross-check:** B2's Payments shows the refund; H2's Earnings shows the reversal for the unheld share only; staff refunds console lists the `plan-end:` key.

**Probe further:**

- The sweep waits while any session is still `SCHEDULED` (not yet auto-completed) or a reschedule is open (`PlanWaiting`). Leave one past session `SCHEDULED` and run it: the plan must stay `APPROVED`. Then run `auto-complete-appointments` and settle again.
- A past session with no meeting becomes `UNVERIFIED`, which counts as **delivered** (decision 9: a no-show is delivered). Does the buyer's copy say so anywhere?

## SU-79 — A returned session never rebooked is refunded at plan end [sweep]

**Why it matters:** returns extend the plan; if the session still never happens, the buyer is owed it.

**Setup:** B3's plan with `sessionsReturned ≥ 1` (SU-68/69). Shift as in SU-78 with nothing placed for the returned sessions.

**Steps:** run the plan-end settlement; read both views.

**Expect:** the returned sessions count as not delivered: `unused = T − delivered`. The refund includes them. `planEndsAt` already includes the +7 days per return.

**Probe further:** the buyer's detail page before plan end: does it still say "You can do this twice per plan" after 2 returns?

## SU-80 — No plan-end choice is offered (extend vs refund)

**Why it matters:** the schema has `PlanEndChoice` and `RegularTime` tables, but the ADR lists the plan-end extra-weeks choice and Regular time as **not built**. The product must not promise them.

**Steps:**

1. On SU-78's plan before settlement, as B2 and as H2, look for any offer of extra weeks, "extend", "keep going", or a choice between weeks and a refund.
2. Search every subscription page you visited in this folder for "Regular time", "same time every week", "Extend the period".
3. Run SQL: `SELECT count(*) FROM "PlanEndChoice"; SELECT count(*) FROM "RegularTime";`

**Expect:**

- UI: no extend offer, no Regular time controls, no "Extend the period" copy (the `PERIOD_ENDED` copy no longer says it).
- SQL: zero rows in both (no code writes them).

**Probe further:** if any copy promises an extension, report **FALSE-INFO** (P1). Note for the owner that `Subscription.planEndChoice`, `regularTimes`, `lastRolledAt`, `rollPausedAt` exist with no reader or writer.

## SU-81 — Paid but never scheduled for 48 hours: full refund [sweep]

**Why it matters:** the "has until … to schedule cycle 1" promise must be kept.

**Setup:** a fresh purchase (B1, SU-01's plan) [local], not allocated. Owner-approved: set the payment's `capturedAt` to 49 hours ago.

**Steps:**

1. As B1 and H1, read the booking before the job (B1: the deadline has passed; record what it says now).
2. Run `expire-stale-requests` (NEEDS-OWNER-RUN on a preview).

**Expect:**

- After: `Subscription.status = EXPIRED`; a full refund P through the refund-owed marker; B1 and H1 notified (R-07).
- Verification SQL: R-03 graph, R-04 money, R-07 outbox for the subscription id.

**Probe further:** between the deadline and the sweep tick, the pages still say "has until <past time>". **FALSE-INFO** (P3) if the past deadline is shown without "passed".

## SU-82 — The 30-day "approved but unallocated" refund applies only to plans that never started [sweep]

**Why it matters:** decision 9: a plan that ever had a confirmed session waits for plan-end settlement instead of a mid-plan refund.

**Setup:** two `APPROVED` subscriptions with no live session (the shape is rare; create it with owner-approved SQL on two fresh purchases):

- A: never had a confirmed occurrence and no reschedule request ever. Set `status = 'APPROVED'`, `updatedAt = now() - interval '31 days'`.
- B: had one confirmed occurrence, now `CANCELLED` (e.g. returned) or tombstoned. Same `status` and `updatedAt`.

**Steps:** run `expire-stale-requests`.

**Expect:** A → `EXPIRED` with a full refund marker. B untouched (still `APPROVED`); it settles at plan end.

**Verification SQL:** R-06 and R-04 for both; `BookingStatusHistory` for A shows `APPROVED → EXPIRED`.

**Probe further:** what does B's buyer see during those 30+ days? Is anything telling them the plan is stalled?

## SU-83 — Renew a plan

**Why it matters:** renewal is the one legitimate second purchase of the same plan, and it must start after the first one ends.

**Setup:** a plan in `APPROVED` with 1 session left, or `COMPLETED` (SU-78). Buyer B2 (or whoever holds it).

**Steps:**

1. As the buyer, find the renewal entry points: the detail page nudge ("1 session left in your subscription with <expert>. Renew now to keep your momentum going." / "You've completed all sessions in this subscription with <expert>. Renew to continue working together.", button **Renew now**), the detail page button **Renew Subscription**, Home ("1 session left in <title>" / "All sessions completed in <title>", CTA **Renew subscription**).
2. Follow one to checkout. Read the banner. Pay (mock) [local].
3. Try to renew the same prior plan again.
4. Try to renew a `PENDING` plan by editing `renewsSubscriptionId` in the URL.

**Expect:**

- Step 2: banner "Renewing your existing subscription — your new period will start immediately after your current subscription ends". New `Subscription` with `renewedFromSubscriptionId` = the prior id, `schedulingPeriodStartsAt` ≥ prior `planEndsAt`, its own frozen terms and `planEndsAt`.
- Step 3: 409 `ALREADY_RENEWED`, "This subscription has already been renewed."
- Step 4: 400 `INVALID_RENEWAL_SOURCE`, "The subscription being renewed was not found or cannot be renewed."
- The double-buy guard (SU-29) doesn't fire for a renewal.

**Cross-check:** H1 sees the renewal as a new request whose cycle 1 starts at the prior plan's end. The renew buttons disappear from the prior plan once a live renewal exists.

**Probe further:**

- Three spellings of one action: "Renew now", "Renew Subscription", "Renew subscription". **COPY** (P3).
- The nudge says "You've completed all sessions" for a plan that ended with sessions **not held** (SU-78)? That would be **FALSE-INFO** (P2); check the detail page of SU-78's plan.
- Does the renewal checkout run the room hint (SU-27) for its own first week, which is in the future?

## SU-84 — The expert has no time left for the remaining weeks

**Why it matters:** an expert who goes on leave or drops their hours leaves a paid plan that can't be scheduled. Both sides need to know what happens.

**Setup:** a plan on H2 or H4 (not H1; F-AV1 must stay intact), weeks 1–2 placed, bought by B3 [local]. As that expert, switch Availability to **Custom Schedule** with no dates (or remove all weekly rows; record them to restore).

**Steps:**

1. As the expert, open the plan's allocate page. Read the tray warnings and the grid.
2. Click **Auto-schedule this week** for week 3 when it opens (shift the clock if needed).
3. As B3, open Home and the plan detail. Read every status line and action.
4. As a new buyer (B1), open checkout for the same plan.
5. Restore the expert's availability.

**Expect:**

- Step 1: warnings "No availability is published, so no session can be placed." and "Sessions that never get a time are refunded to the client when the plan ends." Grid cells closed.
- Step 2: 400 `SLOT_SHORTAGE` with `placeableSessions: 0`; no partial dialog (nothing fits).
- Step 3: B3 sees the plan as active, with weeks 1–2 delivered or upcoming. Record whether anything tells B3 that the expert has no hours, that unheld sessions are refunded at plan end, or that cancelling now refunds the never-scheduled sessions at 100%.
- Step 4: red alert and 409 `NOT_PLACEABLE` (week 1 holds nothing).

**Probe further:**

- If B3 learns nothing until plan end, report **MISSED-OPPORTUNITY** (P1): the buyer pays for weeks they can't use and is told only after.
- Does the expert get a nudge for unplaced weeks (week-nudge sweep) that says "you have no hours"?
- What would B3 try next: message the expert, cancel, contact support? Walk the cancel quote: it should be 100% for every session not yet scheduled (SU-72 rule).

## SU-85 — Folder cleanup

**Why it matters:** the database is shared.

**Steps:**

1. R-08 for every `qa-SU-` row and every purchase you made in this folder.
2. Cancel through the product any plan still live (prefer the cancel door).
3. For mock-payment rows only, run R-09 per appointment with owner approval, children first.
4. Archive `qa-SU-` plans (SU-22).
5. Confirm H1's, H2's and H4's availability match F-AV1/2/4 (R-02).

**Expect:** a ledger with each id and its cleanup status. Never delete a non-mock `Payment`.

**Probe further:** list rows you couldn't delete and the blocking table.
