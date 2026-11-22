# 08-b · Money: cancel quotes, tier edges, rails and group-event quotes

**Needs:** bookings from 03, 04, 05, 06 and MO-01…MO-09; local `next dev` for `[local]`. Owner-approved SQL for clock shifts (`_shared/personas-and-fixtures.md` §4). MQ-queries in [README.md](README.md).
**Personas:** B1 (IST), B2 (London), B3 (Los Angeles), B4 (Wipro), H1, H2, OS, ST, AD.
**Docs under test:** `docs/booking/08-cancellation-flow.md`, `lib/payments/operations/cancellation-policy.ts`, `app/api/appointments/[appointmentId]/cancel/{route,preview/route}.ts`.

Tier journeys (100 / 50 / 0 %, frozen window, quote changed, expert cancel) are CO-71…CO-86, SU-72…SU-77, TR-29…TR-33, WE-42, CL-35. These cases test the **quote contract**, the edges between tiers, the rails and the arithmetic.

The preview is `GET /api/appointments/[aid]/cancel/preview`. Its 1:1 body has `refundPct`, `estimatedRefundPaise`, `creditRestoresInFull`, `creditReturnNeedsReview`, `currency`, `hoursUntilNextSession`, `prorated`, `fundingRail`, `payerOrganizationName`, `wholeEvent: false`, `attendeeCount: null`, `expectedPaid`. The cancel is `POST …/cancel` with optional `expectedRefundPaise`, `expectedCreditRestoresInFull`, `expectedPaid`, `notes`.

## MO-15 — The preview's shape and authorisation mirror the cancel

**Why it matters:** a quote for an action the viewer can't take leaks a booking's price.

**Setup:** MO-01's booking (B1 ↔ H1).

**Steps:** call the preview as B1, H1, B2 (stranger), signed out, ST (staff, not a party), and with a random uuid as B1. Then `POST …/cancel` as ST with `{}`.

**Expect:**

- B1 and H1: `200` with every field above. H1's quote is 100 % (expert-initiated pays in full); B1's follows the tier.
- B2: `403` "You are not authorized to cancel this appointment". Signed out: `401`. Unknown id: `404` "Appointment not found".
- ST preview: record the status. ST cancel: `403` `PLATFORM_CANCEL_DOOR_REQUIRED` "Cancel this booking from the back office so the refund is audited." If the ST preview answers `200`, write it in the report as an open point (the preview quotes a cancel this door refuses; the back-office door may need the quote).

**Probe further:** does the preview carry `Cache-Control: no-store` (it should; the number moves with the clock)? Does B2's 403 differ from the 404 in a way that confirms the booking exists?

## MO-16 — Exactly 24 hours and exactly 2 hours `[local]`

**Why it matters:** the ladder is "at least N hours before"; off-by-one at the rung is a money bug either way.

**Setup:** three fresh S-08 bookings by B3 (Mock Pay). Owner-approved shifts, all on the UTC half hour relative to `now()` rounded **up** to the next half hour `T`: booking A starts at `T + 24 h`, B at `T + 24 h − 30 min`, C at `T + 2 h`. Record `now()` and each `startsAt`.

**Steps:** within the same minute, call the preview for A, B and C. Then compute hours yourself from `hoursUntilNextSession`.

**Expect:** A (≥ 24 h) 100 %; B (< 24 h) 50 %; C: 50 % while `hoursUntilNextSession ≥ 2`, then 0 % once the clock passes `startsAt − 2 h`. Call C's preview again after that moment and confirm it drops. The quote equals `amount × pct` floored to whole paise (₹8,474.09 at 50 % refunds 423704 paise), and the expert's reversed share is floored too; record both on an odd amount.

**Probe further:** does the cancel dialog's sentence change at the same instant as the number? Does it say "50 % because it's less than 24 hours away" or just a figure?

## MO-17 — An old client with no `expectedRefundPaise` is unbound; a credit mismatch is refused `[local]`

**Why it matters:** the bound quote is the fix for "the dialog said X, I got Y"; the unbound path must still charge the server's own figure.

**Setup:** two B1 bookings at ≥ 24 h (salvaged from old 016 Phase 2.3).

**Steps:**

1. Cancel booking 1 with body `{ "notes": "qa-MO-17" }` (no expected figure).
2. On a credit-funded booking (MO-08 step 2, if it exists) cancel with `expectedCreditRestoresInFull: false` while the preview says `true`.

**Expect:** step 1: `200`, refund = the preview's figure, `rail: "GATEWAY"` in the response, one `Refund` row `cancel:<aid>:<pid>`. Step 2: `409` `REFUND_QUOTE_CHANGED` "The refund for this booking has changed since you saw it. Check the new amount and confirm again." and nothing committed (R-03 status unchanged, no `Refund`, `refundOwedKey` null).

**Probe further:** the bound-quote 409 for a changed **amount** is CO-75; don't repeat. Does the UI re-open the dialog with the new figure after the 409, or show a toast only?

## MO-18 — A capture that lands after an unpaid quote re-quotes instead of cancelling

**Why it matters:** a buyer who pressed cancel on an unpaid screen must not lose a tier of a payment that just went through.

**Setup:** needs Razorpay test mode or an owner webhook replay: an approval pay link (CO-25) still `PENDING`.

**Steps:** as B1 open the cancel dialog (preview says `expectedPaid: false`). Pay the link in another tab (or owner replays the capture). Confirm the cancel with `expectedPaid: false`.

**Expect:** `409` `REFUND_QUOTE_CHANGED` with "Your payment just went through. Review the refund before you cancel."; nothing committed; the next preview shows `expectedPaid: true` and a tiered figure. Without a gateway: BLOCKED (no gateway).

**Probe further:** if the capture lands mid-transaction, the route may answer `409` `BOOKING_CHANGED` "This booking changed while you were cancelling it. Refresh to see where it stands, then try again." Record which appeared.

## MO-19 — A prorated subscription quote reconciles to the paise `[local]`

**Why it matters:** proration is the one place the refund isn't a flat percentage.

**Setup:** B1's weeks plan from SU-23 with week 1 placed (3 sessions). Owner-approved: move session 1 into the past and mark it `COMPLETED`.

**Steps:** preview as B1; record `prorated`, `refundPct`, `estimatedRefundPaise`, `hoursUntilNextSession`. Run R-06.

**Expect:** `prorated: true`. Reconstruct the figure: base = `amount × sessionsRemaining / sessionsTotal` (record the exact numerator the quote used: remaining = total − completed − refunded − returned?), then the tier of the **next** session, clamped to the refundable balance. Write the formula you derived and show it equals `estimatedRefundPaise`. An untouched plan (no session delivered) must give `prorated: false` and the whole price at its tier.

**Probe further:** SU-73 cancels it; here, compare the dialog sentence with the number. Does the dialog explain "3 of 12 sessions used"? A figure with no basis is a MISSED-OPPORTUNITY.

## MO-20 — Leaving a webinar seat: the seat quote and the event window `[local]`

**Why it matters:** seats don't use the 1:1 ladder; they refund in full until the event window, then refuse.

**Setup:** B2's paid seat (MO-04). Read `WebinarPlan` (or the seat's snapshot) refund window; default 24 h (`EVENT_REFUND_WINDOW_HOURS_DEFAULT`).

**Steps:**

1. As B2 call `GET /api/appointments/<id>/cancel/preview?scope=seat`. Record the body.
2. Owner-approved: move the webinar to start inside the window (window − 1 h). Call it again, then try to leave in the UI (the leave is `DELETE /api/participants/webinar/<eventId>?userId=<B2>`).

**Expect:** step 1: a full refund of B2's seat (record field names; this branch returns `quoteSeatLeave`). Step 2: the leave is refused with human copy naming the window (record the code). Without `?scope=seat`, B2's preview is `403` (attendees can't cancel the whole event), and the appointment cancel route answers `403` to a seat holder: a seat leaves only through the participants route.

**Probe further:** after a re-time, free leave is WE-38/39; don't repeat. Does the seat dialog state the window in hours and in B2's local time ("until Tue 14:30 BST")?

## MO-21 — Leaving a class seat refunds only sessions not yet held `[local]`

**Why it matters:** a class seat is N units; held sessions are not refundable.

**Setup:** B3's class seat (MO-05). Owner-approved: mark the first session `COMPLETED` in the past (only if CL-35 hasn't already covered leaving; otherwise reuse its numbers).

**Steps:** `?scope=seat` preview as B3; then leave through `DELETE /api/participants/class/<eventId>?userId=<B3>` (if allowed at this notice).

**Expect:** the quote equals unit × sessions not yet held (unit = `amount / sessionsPurchased`, record rounding); the `Refund` row matches; `refundedShareAmount` on H2's earnings moves by the same fraction.

**Probe further:** is "one session = ₹X" shown anywhere? Leaving inside the window before the first session is CL-36.

## MO-22 — Whole-event quote counts paid seats, not the roster `[local]`

**Why it matters:** the organiser owns no seat; quoting their own payment once said "no refund" while the click refunded everyone (old 010 Phase 3).

**Setup:** F-PL2a webinar with: B2 paid seat, B3 paid seat, one free registrant (DR via a ₹0 seat on the free webinar is a different event, so use a 100 % discount code or skip), and one seat already refunded (B3 leaves first, MO-20 style). Record each payment.

**Steps:** as H2 call the preview (no `scope`).

**Expect:** `wholeEvent: true`, `refundPct: 100`, `hoursUntilNextSession: null`, `prorated: false`, `fundingRail: null`, `attendeeCount` = live **paid** seats (not roster size), `estimatedRefundPaise` = sum of those seats' refundable balances (a released seat counts 0). Cancelling is WE-42; there, check the refunds sum to this figure (`event-cancel:<webinarId>:pay:<paymentId>` per seat).

**Probe further:** `estimatedRefundPaise: 0` with paid seats is the old regression: P0. Does H2's dialog say how many people are refunded and how much in total?

## MO-23 — The rail field names the money's way home

**Why it matters:** an org-funded learner was once told their card would be credited in 5–7 days for a card never charged.

**Setup:** three bookings: MO-01 (card), CO-12 (Wipro-funded, `paymentIntent` starts `org_`), MO-08 step 2 (credits, `free_`, amount 0). Confirm prefixes by SQL first.

**Steps:** preview each as its buyer; read the cancel dialog sentence for each.

**Expect:**

| Booking | `fundingRail` | `payerOrganizationName` | `creditRestoresInFull` | Dialog |
| --- | --- | --- | --- | --- |
| Card | `GATEWAY` | null | false | money back to the original method; record the stated delay |
| Wipro | `INTERNAL` | "Wipro Limited" | false | the organisation is credited; nothing was charged to the learner |
| Credits | `CREDITS` | null | true at 100 % tier | credits come back in full; no ₹0 refund line |

**Probe further:** a mixed payment (credits + card, `free_` with amount > 0) settles on the money arm; if you can make one, record `creditReturnNeedsReview` and the copy.

## MO-24 — An org-funded cancel reverses in the ledger, never at the gateway

**Why it matters:** a gateway refund on an `org_` intent fails with an unknown-gateway error and historically reversed nothing.

**Setup:** CO-78 runs the cancel journey. Read its booking after the cancel.

**Steps:** MQ-1 and MQ-3 for the payment; compare with the Wipro billing account.

**Expect:** the cancel response has `rail: "INTERNAL"`; any `Refund` row has no gateway refund id from Razorpay (record `refundId` prefix and `paymentGateway`); an `INVOICE_ACCRUAL_REVERSAL` leg (Wipro is INVOICE-funded) or an equivalent ledger entry nets the accrual down; the program engagement count returns by one; H1's earnings reverse in proportion.

**Cross-check:** OS's org spend/billing view drops by the same amount; B4's Payments shows no personal money.

**Probe further:** does OS see a line saying a booking was cancelled and credited, with the learner's name and date?

## MO-25 — IIT Madras wallet and credit pool: the money and the credit come back

**Why it matters:** the hybrid org funds bookings from a wallet and a credit budget; both must restore.

**Setup:** IL (IIT learner, folder README). Find an expert IL can book with IIT funding (an IIT internal or external consultant). If IIT funding can't be selected at checkout for IL, BLOCKED and record why.

**Steps:**

1. Read the IIT wallet balance (`WALLET` ledger account for IIT) and the program's credit usage for this cycle.
2. As IL book with org funding (`[local]` if a gateway leg is involved; a wallet-only booking may complete on a preview: record).
3. Cancel at ≥ 24 h.

**Expect:** step 2: `paymentIntent` starts `org_wallet_`; a `WALLET` leg; wallet balance down by the price; one engagement used. Step 3: `fundingRail: "INTERNAL"`, wallet up by the refund, engagement returned, no gateway call.

**Cross-check:** IIT owner's org billing (`/dashboard/org-workspace/[id]/billing`) shows both movements with dates in IST.

**Probe further:** if the wallet is below the price, what does IL see at checkout, and is the learner's card ever charged instead? It must not be (SU-33 pattern).

## MO-26 — The org's own cancellation ladder, frozen on the booking

**Why it matters:** an org editing its ladder later must not change terms a buyer already bought under.

**Setup:** read `Appointment.cancellationPolicyId` for CO-12 (Wipro) and MO-01 (personal). Read the policy rows: `SELECT p.id, p."organizationId", p.version, p.status, p."consultantInitiatedBps", t."hoursBefore", t."refundBps" FROM "CancellationPolicy" p JOIN "CancellationPolicyTier" t ON t."policyId" = p.id WHERE p.id IN (:a, :b) ORDER BY p.id, t."hoursBefore" DESC;` (a null `organizationId` is the platform ladder; a null `cancellationPolicyId` falls back to it).

**Steps:** compare each booking's preview tier with its own policy rows.

**Expect:** each booking quotes from its own policy version. If Wipro has published its own ladder, CO-12 follows it; otherwise both follow the platform ladder (100 / 50 / 0 at 24 h / 2 h). Wipro's door is `app/api/organizations/[orgId]/cancellation-policy`; find its UI in the org workspace as OS and read it, but **don't publish** (a new version changes a shared org's terms for every later booking). Record whether the editor says existing bookings keep their terms.

**Probe further:** does the buyer ever see which ladder applies ("Wipro's policy" vs "Familiarise policy")?

## MO-27 — An expert's full-refund cancel of a discounted, partly refunded booking `[local]`

**Why it matters:** "full refund" must mean the refundable balance, not the list price.

**Setup:** MO-09's discounted booking (if not cancelled yet), plus a partial refund of ₹100 issued by AD (MO-32).

**Steps:** as H1 preview and cancel.

**Expect:** `refundPct: 100`; `estimatedRefundPaise = amount − already refunded`; the `Refund` row matches; total refunds = `amount` exactly; one strike for H1 (CO-81 pattern).

**Probe further:** H1's dialog says "{client} gets a full refund of ₹X": is X the balance or the original price?

## MO-28 — The cancel dialog's numbers on each surface `[local]`

**Why it matters:** the same refund is described on four screens; any mismatch is a support ticket.

**Steps:** for MO-17's cancelled booking, read: the cancel dialog (before), the success toast, B1's appointment detail, B1's Payments row, B1's bell and the email subject (NotificationOutbox), H1's appointment detail and Earnings.

**Expect:** the same ₹ amount and the same tier everywhere; "refund on its way" style wording while `PENDING`, "refunded" once `SUCCEEDED` (mock refunds settle at once). Dates in each viewer's zone.

**Probe further:** quote every refund sentence verbatim and judge it for slop and for promises the system can't keep ("instantly", "within 24 hours").
