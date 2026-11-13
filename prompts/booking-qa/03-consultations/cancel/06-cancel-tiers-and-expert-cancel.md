# 03-f · Consultations: cancelling (consultee tiers, quote binding, expert cancel and strikes)

**Needs:** local mock pay for fixtures; owner-approved time shifts.
**Personas:** B1 (IST), B2 (Europe/London), B3 (America/Los_Angeles), B4 (IST, Wipro), H1 (IST).
**Docs under test:** `docs/booking/08-cancellation-flow.md` ("Refund Quote Binding and Durability", "Refund and Earnings"), `lib/payments/operations/cancellation-policy.ts`, `lib/booking/session-window.ts`, `components/appointments/consultee/CancelConfirmationDialog.tsx`, `lib/appointments/payment-display.ts`.

Rules under test (from code):

- Platform ladder: ≥ 24 h notice → 100 %; 2 h to < 24 h → 50 %; < 2 h → 0 %. Notice is measured from now to the session start. The ladder frozen on the appointment at purchase (`cancellationPolicyId`) applies; org-funded bookings use the funding org's ladder.
- Inside 15 minutes before the start until the end: 409 `SESSION_IN_PROGRESS`.
- The dialog quote is binding: the cancel sends `expectedRefundPaise`; a different server quote → 409 `REFUND_QUOTE_CHANGED` with the new quote.
- The refund is stamped as a per-payment refund-owed marker in the cancel's commit and driven under `dedupeKey: "cancel:<appointmentId>:<paymentId>"`.
- A booking with no session ever scheduled refunds in full.

Fixture per case: book S-08 with Mock Pay (B as named), then shift the occurrence with owner-approved SQL to the notice the case needs, keeping the start on the UTC half hour: `UPDATE "AppointmentOccurrence" SET "startsAt" = date_trunc('hour', now()) + interval '<N> hours <M> minutes', "endsAt" = … + interval '1 hour' WHERE id = :occId;`. Say in the report exactly what you shifted.

After every case: R-03, R-04 (refund rows, `refundOwedKey` set then cleared), R-05, R-07. Money depth (GST credit notes, TDS, payout clawback) belongs to 08.

## CO-71 — Cancel with ≥ 24 h notice: full refund `[local]`

**Why it matters:** the common case; quote, refund, earnings and freed time must agree.

**Setup:** B1 books S-08 at Tue D+8 17:00 IST (≥ 24 h away, no shift needed).

**Steps:**

1. As B1 open the booking detail → **Cancel booking**. Wait for "Checking what you'd get back…" to resolve.
2. Read the title ("Cancel consultation?"), the refund sentence, the policy line, the buttons ("Keep booking", "Cancel and refund").
3. Note `GET /api/appointments/[aid]/cancel/preview` in the network panel (refund paise, pct).
4. Confirm. Read the toast.

**Expect:**

- Dialog: "You'll be refunded ₹<amount> (100%) … Refunds reach your original payment method in 5–7 working days." (amount = full paid incl. tax, or ex-tax; record and compare with the preview JSON). "This action cannot be undone."
- `POST /api/appointments/[aid]/cancel` body carries `expectedRefundPaise` equal to the preview; → 200.
- DB: consultation `CANCELLED`; occurrence `CANCELLED` (row kept); `Refund` row with `dedupeKey = 'cancel:<aid>:<pid>'`, amount = quote, status SUCCEEDED/PENDING (mock); `Payment.refundOwedKey` set in the commit and cleared once driven; earnings `refundedShareAmount` = full share.
- Toast "A refund of ₹X (100%) is on its way back to you."
- H1's grid frees Tue D+8 17:00.

**Cross-check:** B1 payments shows the refund; H1 earnings shows the reversal; staff payment page lists the refund; bell + outbox `APPOINTMENT_CANCELLED` to both.

**Probe further:** the dialog never names the policy's tiers: is there a link to them? (MISSED-OPPORTUNITY.) Cancel again via API → 409 `NOT_CANCELLABLE`.

## CO-72 — Cancel between 2 h and 24 h: half refund `[local]`

**Setup:** B2 books S-08; shift the occurrence to start in 10 h.

**Steps:** as B2 open Cancel; read; confirm.

**Expect:** preview `refundPct = 50`, `refundPaise = floor(paid × 0.5)` (record rounding); dialog "You'll be refunded ₹X (50%) …" in plain words with the reason (notice under 24 h); refund row = quote. Earnings reversed by half.

**Probe further:** does B2 see the 24-h boundary time ("cancel before <time> for a full refund") anywhere before this? MISSED-OPPORTUNITY if not.

## CO-73 — Cancel under 2 h: nothing back `[local]`

**Setup:** B3 books S-08; shift to start in 90 min.

**Expect:** preview 0 %; dialog "No refund at this notice — cancelling now returns nothing under the booking's cancellation policy."; confirm → `CANCELLED`, refund status `POLICY_ZERO` in the response, no `Refund` row with money; toast "No refund applies under the cancellation policy for this booking." Earnings unchanged (H1 keeps the share; record).

**Probe further:** the button label when nothing is refunded: "Cancel and refund" would be FALSE-INFO; it should be "Cancel booking". Quote it.

## CO-74 — Inside 15 minutes or under way: frozen `[local]`

**Setup:** B1 books S-08; shift to start in 10 min. Then shift so it started 20 min ago (still running).

**Steps:** each time, open Cancel and confirm; also POST the cancel route directly.

**Expect:** 409 `SESSION_IN_PROGRESS` "This session starts in less than 15 minutes or is already under way, so it can't be cancelled now. If something goes wrong, report a problem from the booking after it ends." The dialog (or the detail page) says this before the click if it can. Nothing changes.

**Probe further:** after the session ends, can B1 "report a problem" (support route)? Follow the link and record where it goes.

## CO-75 — The quote changes between the dialog and the click `[local]`

**Why it matters:** the refund charged must be the refund shown.

**Setup:** B2 books S-08; shift to start in 25 h.

**Steps:**

1. As B2 open the Cancel dialog (quote 100 %). Leave it open.
2. Owner-approved: shift the occurrence to start in 23 h (now 50 %).
3. Click confirm in the still-open dialog.

**Expect:** 409 `REFUND_QUOTE_CHANGED` carrying the new quote; nothing committed (status unchanged, no refund row); the dialog re-quotes and shows 50 % with a note that the amount changed, and B2 must confirm again. Confirm → 50 % refund.

**Probe further:** the exact boundary: shift to exactly 24 h 00 min and confirm promptly: tier is 100 % at ≥ 24 h. By the time the request lands it may be 23:59:58 → 50 % and `REFUND_QUOTE_CHANGED`. Record what happens and whether the copy is fair.

## CO-76 — Cancelling a request or an unscheduled booking

**Why it matters:** no session means no notice to measure; nothing paid means nothing to refund.

**Steps:**

1. A PENDING request (H1 in REQUEST mode briefly, or CO-20-style leftover): as the consultee open Cancel.
2. An approved-and-paid consultation whose session was released with "Any time works" and not yet placed (from 03-e): open Cancel.

**Expect:** 1: title "Cancel consultation request?", body "Nothing was paid for this, so there is nothing to refund."; `CANCELLED`. 2: full refund (no slot rows → infinite notice) if the booking truly has no slot rows; if it still has a released row, the tier is computed from that row (record which and whether the copy explains it).

## CO-77 — Cancelling a free consultation moves no money

**Setup:** CO-07's free booking (B4), preview OK.

**Expect:** dialog says nothing is refunded because nothing was paid (quote it); `CANCELLED`; no `Refund` row; any ₹0 payment untouched (no refund on a zero payment); toast without a refund amount. H1's earnings unchanged.

## CO-78 — Cancelling an org-funded booking (Wipro) credits the org

**Setup:** CO-12's booking (B4, Wipro rail).

**Steps:** as B4 open Cancel at ≥ 24 h notice; read; confirm. Repeat the read on OS's dashboard.

**Expect:** dialog "Your organisation is credited ₹X … Your organisation's balance is restored; nothing was charged to you."; the refund is an in-ledger reversal (no gateway call): WALLET balance back up, engagement returned, `Refund` row recorded with the `org_` payment; tier from Wipro's ladder if it published one (record `cancellationPolicyId` and the tier used).

**Cross-check:** OS's org spend and appointments show the cancellation; B4's payments show no personal money.

**Probe further:** an org admin may also cancel on the payer side (`OrgActorDetail`: "Cancel booking" / "Keep booking"): try as OS and record the copy and the tier used.

## CO-79 — Status writes can't cancel

**Steps (`evaluate_script`):** as B1 `PATCH /api/bookings/consultations/[cid]` `{ status: "CANCELLED" }`; `DELETE /api/bookings/consultations/[cid]`.

**Expect:** PATCH 4xx (`USE_CANCEL_ENDPOINT`, message pointing to the cancel route); DELETE 405 `DELETE_NOT_SUPPORTED`. Nothing changes.

## CO-80 — Cancelling a booking with an open reschedule closes the proposal

**Why it matters:** an ending booking must not leave a live proposal or a held lock.

**Setup:** a B3 booking with an open out-of-hours proposal (03-e CO-47 shape), ≥ 24 h away.

**Steps:** as B3 cancel the booking.

**Expect:** booking `CANCELLED`; the proposal `DECLINED` by `declineOpenReschedules`, `openForAppointmentId` NULL; refund per tier measured from the **original** session start (record which start was used: the released row's); H1's Requests row gone.

**Probe further:** what does H1 see: "cancelled" or a dead "Accept new times" button?

---

**Part 2 — Consultations: the expert cancels, and reliability strikes**

**Needs (part 2):** local mock pay for fixtures; owner-approved time shifts.
**Personas:** H1 (IST), H4 (Kathmandu) or H3 for the threshold case, B1, B2, ST, AD.
**Docs under test:** `docs/booking/08-cancellation-flow.md`, `lib/booking/expert-reliability.ts`, `lib/booking/expert-reliability-rules.ts`, cancel route (`app/api/appointments/[appointmentId]/cancel/route.ts`, the `isExpertSideCancel` branch).

Rules under test (from code):

- An expert-side cancel refunds 100 % at any notice before the frozen window.
- A strike is recorded when the expert cancels a **confirmed** booking, free or paid (a paid payment, or `APPROVED`), as a `SystemEvent` (`category = 'BOOKING'`, `message = 'Expert reliability strike: EXPERT_CANCEL'`, `context.strike`, `context.consultantProfileId`, `context.appointmentId`, `context.occurrenceIds`).
- Strikes never show on the public profile; the expert sees them on Settings → Booking ("Your reliability"), staff in the strike review card (3 in 90 days reads "needs review").
- Inside the frozen window the host is told: "This session is in progress — end the call and we'll settle it from what happened."

Strike query (run before and after each case):

```sql
SELECT id, message, context->>'strike' AS cause, context->>'appointmentId' AS appt, "createdAt"
FROM "system_events"
WHERE category = 'BOOKING' AND context ? 'strike' AND context->>'consultantProfileId' = :cid
ORDER BY "createdAt" DESC;
```

## CO-81 — The expert cancels a paid booking under 2 h: full refund and a strike `[local]`

**Why it matters:** the client is made whole regardless of tier; the expert's reliability record grows.

**Setup:** B1 books S-08; shift the occurrence to start in 90 min (the client's own tier would be 0 %).

**Steps:**

1. As H1 open the booking (`/dashboard/consultant/[H1 cid]/appointments/[aid]`) → **Cancel booking**.
2. Read the dialog: "<B1 name> gets a full refund of ₹<amount>." then "Cancelling a confirmed booking, free or paid, is recorded on your reliability record. Only you and our team see it." and the buttons.
3. Confirm.

**Expect:**

- Preview and refund 100 %; `Refund` row = full amount; `dedupeKey = 'cancel:<aid>:<pid>'`; earnings fully reversed.
- One new strike row with cause `EXPERT_CANCEL` for H1, `appointmentId` = this booking, `occurrenceIds` = the cancelled session.
- B1 told (bell + outbox) that H1 cancelled and a full refund is on its way; copy doesn't blame B1.

**Cross-check:** B1 payments (refund), H1 earnings (reversal), staff strike review list (if the back office shows one) gains the row.

**Probe further:** does H1's dialog say how many strikes H1 already has, or what 3 means? MISSED-OPPORTUNITY if it only says "counts against". Does it offer "Reschedule instead"?

## CO-82 — The expert cancels a free booking: no money, one strike

**Why it matters:** an expert's cancel of any confirmed booking, free or paid, is a strike (owner decision 2026-11-12), and a free cancel writes no refund record.

**Setup:** B4 books S-09 (free), preview OK.

**Steps:** as H1 cancel it. Read the dialog.

**Expect:** the dialog says "Nothing was paid for this, so there is nothing to refund." and the reliability line, and its button reads "Cancel booking"; `CANCELLED`; one new `EXPERT_CANCEL` strike; no `Refund` row, no refund marker on the payment, no `REFUND_PROCESSED` email, and B4's cancellation email has no refund sentence.

## CO-83 — The expert can't cancel a session under way

**Setup:** B2 books S-08; shift to start in 10 min.

**Steps:** as H1 open Cancel and confirm; POST the route.

**Expect:** 409 `SESSION_IN_PROGRESS` with the host copy "This session is in progress — end the call and we'll settle it from what happened." No strike, no refund.

**Probe further:** what does "settle it from what happened" lead to (no-show reporting, attendance)? Follow it and record; depth is 12 (session-outcome sweeps).

## CO-84 — Expert cancel while the client's proposal is open

**Why it matters:** an ending booking closes open proposals; the strike and refund still apply.

**Setup:** B3 booking with an open out-of-hours proposal (03-e shape), ≥ 24 h away.

**Steps:** as H1 cancel the booking (not the proposal).

**Expect:** booking `CANCELLED`, proposal `DECLINED` (closed by `declineOpenReschedules`), 100 % refund, one strike. B3's view shows the cancellation, not a pending proposal.

## CO-85 — Strikes stay private: the expert's own record and the staff review

**Why it matters:** strikes are never public (owner decision 2026-11-12); the expert and staff see them.

**Setup:** use H3 (keep H1's record small). Create three paid H3 bookings `[local]` (H3 needs a priced consultation: create "qa-CO-85" 60 min) and cancel each as H3. Between the second and third, check the profile.

**Steps:** after 3 strikes, open `/explore/experts/[H3 cid]` as B1. As H3 open Settings → Booking. As ST/AD open the expert strike review card in the back office.

**Expect:** the public profile shows no reliability line at any count. H3's "Your reliability" card reads "3 recorded in the last 90 days" with each cause and date. Staff review lists H3 with 3 strikes, "needs review", and the last strike time. `GET /api/user/consultants/[H3 cid]/strikes` answers 403 for anyone but H3.

**Probe further:** is H3's card plain about what counts and who sees it? Archive the plan afterwards.

## CO-86 — Expert-side cancel by an org admin (payer side) and by staff

**Why it matters:** who cancels decides the tier and the strike.

**Steps:**

1. On CO-12-shaped booking (Wipro-funded), as OS cancel from the org detail ("Cancel booking" / "Keep booking"). Read the quote.
2. As ST, open a QA booking in the back office and cancel through the platform cancel door (`PlatformCancelDoor`: "Cancel booking"). Read the quote and the reason field.

**Expect:** 1: OS acts on the payer side: the tier is the payer's ladder (not 100 % automatically); no expert strike. 2: a platform cancel refunds 100 % (platform-initiated) and records no expert strike unless the code says otherwise (record). Both write history with the actor.

**Probe further:** the consultant cancel from staff (`PLATFORM_CANCEL_DOOR_REQUIRED` when a privileged user uses the ordinary route): try the ordinary cancel route as ST and record the 403 copy.
