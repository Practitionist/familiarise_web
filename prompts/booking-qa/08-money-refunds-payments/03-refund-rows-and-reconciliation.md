# 08-c · Money: refund rows, keys, credit notes and the pages that report them

**Needs:** refunds produced by 03–07 and 08-a/08-b. Local `next dev` for `[local]`. MQ-queries in [README.md](README.md).
**Personas:** B1, B2, B3, B4, H1, H2, AD (refund door, step-up), ST (read).
**Docs under test:** `docs/booking/` money pages, `lib/payments/operations/{refund,booking-refund,event-refunds,refund-owed}.ts`, `components/dashboard/backoffice/money/*`.

## MO-29 — Every refund carries its door's key, once

**Why it matters:** the `dedupeKey` is what stops a retry paying twice; a refund under the wrong key escapes that protection.

**Setup:** run after 03–07 and 08-a/08-b. Collect every refund on a QA payment:

```sql
SELECT r."dedupeKey", r.status, r."amountPaise", r."paymentId", r."createdAt", p.amount, p."appointmentId"
FROM "Refund" r JOIN "Payment" p ON p.id = r."paymentId"
WHERE p."userId" IN (:b1, :b2, :b3, :b4, :dr, :il) AND r."createdAt" > :runStart
ORDER BY r."createdAt";
```

**Expect:** each key matches its door, and no non-null key appears twice:

| Door (owning case) | Key shape |
| --- | --- |
| 1:1 cancel (CO-71…, SU-72…) | `cancel:<appointmentId>:<paymentId>` |
| Whole webinar/class cancel (WE-42, 06) | `event-cancel:<eventId>:pay:<paymentId>` |
| Class end, never-placed sessions (SW-24) | `class-end:<classId>:pay:<paymentId>` |
| Host-cancelled class session not made up, or skip make-up (06, SW-26) | `occ:<occurrenceId>:pay:<paymentId>` |
| Plan end (SU-78, SW-28) | `plan-end:<subscriptionId>:pay:<paymentId>` (record if the marker is `plan-end:<subscriptionId>`) |
| Expert/learner trial cancel (TR-29, TR-32) | `trial-cancel:<trialId>:<paymentId>` |
| Unanswered paid trial (SW-19) | `trial-unanswered:<paymentId>` |
| Parked consultation (CO-89) | `parked-consultation:<consultationId>:<paymentId>` |
| Consultant no-show (SW-21) | `consultant-no-show:<paymentId>` |
| Decline of a paid request (CO-38) | `rejection:<requestId>:<paymentId>` |
| Admin refund door (MO-32) | `admin-refund:<adminUserId>:<paymentId>:<Idempotency-Key>` |

A `FAILED` row may have a null key (a failed reservation gives up its key to the next attempt). Any key shape not in this table: record it with its door.

**Probe further:** list doors that refunded with **no** key; each is a double-pay risk worth a BUG.

## MO-30 — Money invariants hold on every QA payment

**Why it matters:** the invariants are the last line against silent money loss.

**Steps:** run the invariant block from `_shared/sql-recipes.md` (R-04 notes) for every QA payment, plus:

```sql
-- refunds never exceed the charge
SELECT p.id, p.amount, sum(r."amountPaise") AS refunded
FROM "Payment" p JOIN "Refund" r ON r."paymentId" = p.id AND r.status IN ('PENDING','SUCCEEDED')
WHERE p."userId" IN (:buyers) GROUP BY p.id, p.amount HAVING sum(r."amountPaise") > p.amount;
-- no refund on a zero payment
SELECT r.id FROM "Refund" r JOIN "Payment" p ON p.id = r."paymentId" WHERE p.amount = 0 AND r."amountPaise" > 0 AND p."userId" IN (:buyers);
-- one journal per settled refund
SELECT r.id, count(t.id) FROM "Refund" r LEFT JOIN "LedgerTransaction" t ON t."idempotencyKey" = 'refund:' || r."refundId"
WHERE r.status = 'SUCCEEDED' AND r."paymentId" IN (:qaPayments) GROUP BY r.id HAVING count(t.id) <> 1;
```

**Expect:** zero rows from each query. For each refunded payment, `ConsultantEarnings.refundedShareAmount / consultantSharePaise` ≈ refunded / amount: a partial refund (CO-72's 50 % cancel) reverses `floor(consultantSharePaise × refunded / amount)`; record the figures on an odd share, and whether a later refund that completes the payment ends the share at exactly zero; a settled refund has `cascadedAt` set.

**Probe further:** any `SUCCEEDED` payment with no live booking and no refund is a P0 (charged, nothing delivered).

## MO-31 — A mock refund settles at once and cascades to earnings `[local]`

**Why it matters:** the earnings clawback is what stops the expert being paid for a refunded session.

**Setup:** a fresh S-08 booking by B1 (Mock Pay), ≥ 24 h out.

**Steps:** R-04 before; cancel through the UI; R-04 after; MQ-1.

**Expect:** one `Refund` `SUCCEEDED`, `amountPaise = amount`, `cascadedAt` set; earnings `refundedShareAmount = consultantSharePaise` and `status = REFUNDED` (record if it stays `PENDING` with a zero net); one `refund:<refundId>` journal; `refundOwedKey` null; a `ConsumerCreditNote` (MO-35).

**Cross-check:** H1 Earnings no longer counts the booking toward "Cleared, less refunds, waiting for a payout"; staff Money → Refunds lists the refund.

**Probe further:** H1's appointment detail: does it say the client was refunded, and how much?

## MO-32 — The admin refund door: partial, replay, second partial, over-refund `[local]`

**Why it matters:** the only manual money door must be exactly-once per dialog and never exceed the charge.

**Setup:** a fresh S-08 booking by B3 (₹500 + tax, Mock Pay). AD signed in (step-up may prompt; QA operators need no TOTP on previews and local).

**Steps:**

1. As AD open `/dashboard/staff/money/refunds` (or `/dashboard/admin/money/refunds`), **Refund doors → Issue refund** for B3's payment, ₹100, reason `qa-MO-32`. Capture the `POST /api/admin/refunds` request: its `Idempotency-Key` header.
2. `evaluate_script` the same request again with the same key and body.
3. Issue a second ₹100 refund from a fresh dialog (new key).
4. Try a refund larger than the remaining balance.
5. Send the POST without an `Idempotency-Key` header.
6. As ST open the same page; record whether **Issue refund** is offered and what happens.

**Expect:** step 1: one `Refund` ₹100 with key `admin-refund:<AD userId>:<paymentId>:<key>`; step 2: no second row (same refund returned or a typed answer; record); step 3: a second row, total ₹200; step 4: refused with human copy, nothing written; step 5: `400` `IDEMPOTENCY_KEY_REQUIRED` "An Idempotency-Key header (10–255 characters) is required, one per refund dialog."; step 6: ST can't issue it directly (the door is ADMIN with step-up); record what ST sees (a proposal/approval path, or no button).

**Cross-check:** B3's Payments shows two partial refunds and the remaining paid amount; H1's earnings reverse by 2/`amount` of the share; an ops log/audit row exists (Money → Audit log).

**Probe further:** the dialog: does it show the refundable balance before you type? Does the reason field accept anything, or a typed reason list?

## MO-33 — After a partial refund, the cancel refunds the tier of what's left `[local]`

**Why it matters:** clamping must use the refundable balance; a tier of the original charge would over-refund.

**Setup:** MO-32's booking (₹200 already refunded), ≥ 24 h out.

**Steps:** as B3 preview, then cancel through the UI.

**Expect:** quote = `min(tier × amount, amount − 20000)`; record which the code applies (tier of gross then clamp, or tier of balance). The cancel `Refund` equals the quote; total refunds ≤ `amount`. Write the arithmetic in the report.

**Probe further:** does B3's dialog mention the earlier partial refund, or does it show a figure that looks wrong without context?

## MO-34 — Cancelling free and credit-funded bookings writes no refund row

**Why it matters:** a ₹0 refund row is noise at best and a gateway error at worst.

**Setup:** CO-07's free booking (or CO-77's result) and MO-08 step 2's credit booking.

**Steps:** cancel each (if not already); read the cancel response `refund` object; R-04; for credits, `ReferralCreditUsage` and `ReferralCredit.remainingAmount` before and after.

**Expect:** no `Refund` row for either. Free: response `refund.status` is `NOTHING_REFUNDABLE` or no refund block (record). Credits: `creditRestoresInFull` was true; credit `remainingAmount` back by the amount used; response `rail: "CREDITS"`.

**Cross-check:** B4/B1 Payments show no refund line for the free booking; the credits view shows the credit restored ("Usage history").

**Probe further:** what does the cancel success copy say for a free booking: "refund", "nothing to refund", or nothing? "Refund of ₹0" is COPY.

## MO-35 — Each refund on an invoiced payment gets a credit note with the tax split `[local]`

**Why it matters:** GST law needs a credit note per refund against the original invoice.

**Steps:** for MO-31 (full) and MO-32 (two partials):

```sql
SELECT n."creditNoteNumber", n."refundId", n."taxableValuePaise", n."cgstPaise", n."sgstPaise", n."igstPaise", n."totalPaise", i."invoiceNumber", i."totalPaise" AS invoice_total
FROM "ConsumerCreditNote" n JOIN "ConsumerInvoice" i ON i.id = n."consumerInvoiceId"
WHERE i."paymentId" IN (:p31, :p32);
```

**Expect:** one credit note per settled refund, `totalPaise` = the refund amount, taxable + tax = total, the same tax heads as the invoice (CGST+SGST vs IGST), tax pro rata to the refund. Credit notes sum ≤ invoice total. Numbers are sequential in the series (no gaps between your two partials, unless another sale took one in between; record).

**Cross-check:** does B3's Payments row or receipt link the credit note? If not, MISSED-OPPORTUNITY.

**Probe further:** a refund on a payment with no invoice (`needsBuyerAddress` or an overseas buyer): record whether a credit note is created and what the buyer sees.

## MO-36 — Wipro's invoice rail: accrual reversal and the org's documents

**Why it matters:** an INVOICE-funded org pays monthly; a cancelled booking must leave the next invoice.

**Setup:** CO-12 and CO-78's cancelled booking (Wipro, INVOICE).

**Steps:** MQ-3 for the payment; `SELECT id, status, "totalPaise", "issuedAt" FROM "OrganizationInvoice" WHERE "organizationId" = :wipro ORDER BY "createdAt" DESC LIMIT 3;` and `SELECT "creditNoteNumber", status, "totalPaise", "invoiceId", "refundId" FROM "CreditNote" WHERE "organizationId" = :wipro ORDER BY "createdAt" DESC LIMIT 5;`. As OS open the org billing page.

**Expect:** the booking added an `INVOICE_ACCRUAL` leg; the cancel added an `INVOICE_ACCRUAL_REVERSAL` (or equivalent) so the next invoice nets to zero for it. If the booking was already on an **issued** invoice, a `CreditNote` with the refund's id appears; if on a draft, the draft line is netted and no credit note is needed (record which happened). Org invoices roll up monthly (`settle-invoice-accruals`, NEEDS-OWNER-RUN; don't wait for it).

**Cross-check:** OS's billing shows the booking and its reversal with the learner's name and the date in IST.

**Probe further:** is there any place OS can see "upcoming invoice" amounts? Does it update after the cancel?

## MO-37 — Consultee Payments page agrees with the database

**Why it matters:** this is where buyers check their money; any mismatch becomes a support ticket.

**Setup:** B1, B2 and B3 each with at least one charge and one refund from earlier cases.

**Steps:** for each buyer open `/dashboard/consultee/[consulteeId]/payments` (the segment is the consultee profile id; record if a user id also works). Read the Needs you band, History (default range, "Last 30 days", "Last 90 days") and Credits. Open each row's detail (`…/payments/[paymentId]`). Compare with:

```sql
SELECT p.id, p.amount, p."paymentStatus", p."createdAt", p."capturedAt", p.description,
       (SELECT json_agg(json_build_object('amt', r."amountPaise", 'st', r.status, 'at', r."createdAt")) FROM "Refund" r WHERE r."paymentId" = p.id) AS refunds
FROM "Payment" p WHERE p."userId" = :uid AND p."deletedAt" IS NULL ORDER BY p."createdAt" DESC;
```

**Expect:** every charge and refund in range appears once, with the right amount, status and offering name. Dates: B3 (Los Angeles) and B2 (London) see dates in **their** zone. Reading the code, `PaymentsTab.tsx` and `PaymentsHistoryList.tsx` format with a fixed `timeZone: "Asia/Kolkata"`; book or refund something for B3 between 17:00 and 23:59 PT (after 00:00 IST next day, i.e. 18:30Z onward) and compare the date shown with B3's local date. A one-day mismatch is FALSE-INFO P2.

**Probe further:** abandoned or expired checkouts: shown as "failed"? Tombstones from MO-13 shown at all? Raw enum words (`SUCCEEDED`) or paise anywhere?

## MO-38 — A failed refund tells the buyer what happens next

**Why it matters:** `FAILED` is terminal; no sweep re-drives it, so the buyer must be told who acts.

**Setup:** a `FAILED` refund only exists after a real gateway refusal (MO-61) or an owner-approved status write on a mock refund: `UPDATE "Refund" SET status = 'FAILED', "failureReason" = 'qa-MO-38', "failedAt" = now() WHERE id = :rid` on a QA mock refund (record and revert at cleanup).

**Steps:** as the buyer open Payments and the home dashboard.

**Expect:** the row shows "Refund failed" and the note "We couldn't return ₹X to your original payment method. Nothing was charged again. Our team re-issues failed refunds by hand within 3 working days — Contact support to follow up." with a working support link; the Needs you band lists it ("refunds that need a follow-up"); the home dashboard action item appears (`failed-refund:` key). Staff Money → Refunds shows it under "Refunds waiting for a human".

**Probe further:** after AD re-issues it by hand (MO-32 door), does the failed note disappear for the buyer? Does the action item clear?

## MO-39 — Consultant Earnings page agrees with the database

**Why it matters:** the expert decides whether to trust the platform from this page.

**Setup:** H1 with at least: one live paid booking, one cancelled-and-refunded, one partially refunded (MO-32), one org-funded (CO-12), one free.

**Steps:** open `/dashboard/consultant/[cid]/earnings` (Summary, Activity, Analytics). Compare with:

```sql
SELECT e.status, count(*), sum(e."grossAmount") gross, sum(e."platformFeePaise") fee,
       sum(e."consultantSharePaise") share, sum(e."refundedShareAmount") refunded, min(e."holdUntil"), max(e."holdUntil")
FROM "ConsultantEarnings" e WHERE e."consultantProfileId" = :h1 GROUP BY e.status;
```

**Expect:** lifetime gross, fee and net equal the SQL sums (net of refunds where the page says "less refunds"); the "Clears after your sessions and the hold" bucket = `PENDING`/`HELD` rows; "Cleared, less refunds, waiting for a payout" = `READY` minus refunds; the next release date = the earliest `holdUntil` in IST. The free booking adds nothing; the org-funded one counts like a card booking. Export the FY CSV and check its totals match.

**Probe further:** does the page explain why a booking is still held (hold period, refund in flight, session not delivered)? A held amount with no reason is a MISSED-OPPORTUNITY.

## MO-40 — Back-office money views agree with each other and with the database

**Why it matters:** ops act from these screens; a wrong figure here becomes a wrong manual refund.

**Steps:** as ST then AD, open Money → Payments, Refunds, Earnings, Reconcile and Approvals (only those each role can open; record the tab list per role), and `/dashboard/staff/payments/[paymentId]` for MO-32's payment.

**Expect:** the payment page shows amount, legs, refunds (with keys or reasons), earnings and the booking link, matching R-04/MQ-1. A tab a role can't open redirects to its first allowed tab, not a 500. Record which tabs ST lacks (Earnings, Org payouts and Reconcile need `payouts.manage`).

**Probe further:** search by payment id, booking id and buyer email: which work? Is the refund's dedupe key or door shown, so ops can tell a cancel from a manual refund?

## MO-41 — A class seat is never paid twice for the same session `[local]`

**Why it matters:** three doors can refund class sessions (skip make-up, host-cancel settle, class end); each must net the others.

**Setup:** B3's class seat with: one host-cancelled session where B3 chose **skip make-up** (06 covers the journey), then owner-approved shifts so the class ends with one session never placed.

**Steps:** NEEDS-OWNER-RUN `auto-complete-appointments` then `retry-auto-refunds` (SW-24). Read all refunds on B3's payment.

**Expect:** one `occ:<occurrenceId>:pay:<paymentId>` refund (one unit) and one `class-end:<classId>:pay:<paymentId>` refund for the never-placed sessions **net of** units already refunded; total ≤ `amount`; no session refunded twice. Write the unit maths.

**Probe further:** B3's Payments shows two refund lines: do their labels tell B3 why each happened?

## MO-42 — An overseas buyer's refund keeps the checkout currency story `[local]`

**Why it matters:** a refund shown in a different currency or rate from the charge looks like lost money.

**Setup:** a B2 (London) booking paid with a display currency other than INR if checkout offers one (`displayCurrency`); otherwise INR, and record that GBP isn't offered.

**Steps:** cancel at ≥ 24 h. R-04 plus `Refund.displayCurrency`, `exchangeRateAtRefund`.

**Expect:** the charge and refund are in INR paise in the DB; the UI states amounts in one consistent currency per screen; if a display currency is shown, the refund line uses the checkout rate or says the bank's rate may differ (record the copy).

**Probe further:** does B2 see "₹" next to a GBP figure, or mixed symbols on one screen?
