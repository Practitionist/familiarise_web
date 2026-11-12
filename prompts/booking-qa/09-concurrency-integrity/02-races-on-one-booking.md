# 09-b · Concurrency: two actions on one booking

**Needs:** local `next dev` for paid fixtures; the harness in [README.md](README.md). Assert the final state is one legal outcome; run R-03, R-04 and R-05 after each.
**Personas:** B1 (IST), B2 (London), H1, H3 (New York), AD.
**Docs under test:** `docs/booking/07-rescheduling-flow.md`, `docs/booking/08-cancellation-flow.md`, `lib/booking/transitions.ts` (CAS from-sets).

Repeat each race three times with fresh bookings.

## CC-14 — Cancel races a new reschedule request `[local]` `[two-browser]`

**Why it matters:** an open request on a cancelled booking is an orphan nobody can close.

**Setup:** B1's paid S-08 booking ≥ 48 h out. Two pages, both B1 (two devices): one on the reschedule page with a green time picked, one with the cancel dialog open.

**Steps:** at once: `POST …/reschedule` (with an `Idempotency-Key`) and `POST …/cancel` (with the dialog's `expectedRefundPaise`).

**Expect:** one wins; the loser gets a typed `409` (`NOT_CANCELLABLE`, `ILLEGAL_TRANSITION`, `RESCHEDULE_STATE_CHANGED` or a reschedule refusal; record), never `500`. If cancel wins: no `RescheduleRequest` with `openForAppointmentId` set; one `Refund`. If reschedule wins: the booking moved (auto-confirm) and the cancel then applies to the new time or was refused; record.

**Probe further:** what does the losing page show? A stale page that still offers "Reschedule" on a cancelled booking is a finding.

## CC-15 — The client accepts while the expert withdraws `[two-browser]`

**Why it matters:** an accepted proposal that was also withdrawn leaves the booking in two places.

**Setup:** H1 proposes a new time on a B1 booking (CO-60). Pages: B1 on the proposal (Accept); H1 on the same booking (Withdraw).

**Steps:** at once: `POST …/reschedule/respond` (accept) and `POST …/reschedule/withdraw`.

**Expect:** exactly one: accepted (one live occurrence at the new time, request `ACCEPTED`) or withdrawn (original restored, request `WITHDRAWN`). The loser `409` `PROPOSAL_NOT_OPEN`. `openForAppointmentId` null afterwards; no live occurrence at **both** times.

**Probe further:** both parties' bells: do they get "accepted" and "withdrawn" for the same proposal?

## CC-16 — The client accepts on one device and cancels on another `[local]` `[two-browser]`

**Why it matters:** salvaged from old 016 Phase 4; the classic accept-vs-cancel.

**Setup:** H1 proposes a new time on a fresh B1 booking. Pages: B1 ×2.

**Steps:** at once: accept and cancel.

**Expect:**

| Winner | Booking | Occurrences | Proposal | Refund |
| --- | --- | --- | --- | --- |
| Accept | not cancelled | one live at the new time | `ACCEPTED` / `AUTO_ACCEPTED` | none |
| Cancel | `CANCELLED` | none live, history kept | closed | one `Refund` |

Loser: typed `409` (`PROPOSAL_NOT_OPEN`, `NOT_CANCELLABLE`, `ILLEGAL_TRANSITION` or `RESCHEDULE_STATE_CHANGED`). `openForAppointmentId` null.

**Probe further:** if cancel won, was the refund tiered on the original time or the proposed time? It should be the live (original) time; record.

## CC-17 — The client and the expert cancel at once `[local]` `[two-browser]`

**Why it matters:** the two cancels pay different amounts (tier vs 100 %) and only the expert's records a strike.

**Setup:** B2's paid S-08 booking at 2–24 h notice (owner-approved shift) so the tiers differ (50 % vs 100 %). Pages: B2 and H1, both with the cancel dialog open.

**Steps:** at once: both confirm.

**Expect:** one `200`; the other `409` `NOT_CANCELLABLE` ("someone else already ended it"). Exactly one `Refund`: 50 % if B2 won, 100 % plus one strike if H1 won. Never two refunds or a strike without H1's cancel.

**Probe further:** the losing party's screen: does it say who cancelled and what was refunded?

## CC-18 — The expert approves while the client walks away `[two-browser]`

**Why it matters:** approving an abandoned request mints a pay link nobody wants.

**Setup:** a fresh priced request from B2 to H1 (H1 in request mode). Pages: H1 (Approve, "Use requested times"); B2 (cancel the request or `POST /api/bookings/[bookingId]/abandon`).

**Steps:** at once.

**Expect:** either approved then the buyer's cancel lands on `APPROVED_PENDING_PAYMENT` (CO-37 path), or cancelled and the approve answers `409` (record code, likely `ILLEGAL_TRANSITION`) with no pay link minted. No `PENDING` payment left on a `CANCELLED` request; no live tentative occurrence.

**Probe further:** a pay link email sent for a request already cancelled: record subject and whether the link still opens.

## CC-19 — The expert withdraws approval as the client pays the link

**Why it matters:** a withdrawn approval must not keep a captured payment.

**Setup:** CO-25's `APPROVED_PENDING_PAYMENT` booking. Needs Razorpay test mode or an owner webhook replay; otherwise BLOCKED (no gateway).

**Steps:** H1 clicks **Withdraw approval** while B1's payment captures (owner posts the capture at the same moment).

**Expect:** either the capture wins (booking confirmed; withdraw refused with a typed `409`, `LOCK_LOST` or a state code; record), or the withdraw wins and the late capture is auto-refunded (`Auto-refund pending:` → `Auto-refunded:`, one `Refund`). Never a confirmed booking with a withdrawn approval, never a captured payment with nothing.

**Probe further:** B1's copy in the withdraw-wins case: "your payment is being refunded"?

## CC-20 — Return a session while rescheduling it `[two-browser]`

**Why it matters:** a session both returned and moved double-counts the plan.

**Setup:** B1's weeks plan with a session ≥ 48 h out. Pages: B1 ×2: one on **Return to plan**, one on reschedule with a time picked.

**Steps:** at once: `POST /api/appointments/[aid]/occurrences/[oid]/return` (with an `Idempotency-Key`) and `POST …/reschedule`.

**Expect:** one wins. If the reschedule opened first, the return answers `409` `RETURN_RESCHEDULE_OPEN` with copy. If the return won, the reschedule is refused (record code). R-06: `live_sessions + sessionsReturned ≤ sessionsTotal`; `planEndsAt` extended by 7 days only if the return committed.

**Probe further:** does the tray "Plan total" on H1's allocate page agree afterwards?

## CC-21 — Two returns at once at the cap `[two-browser]`

**Why it matters:** the cap is two returns per plan; two parallel returns at 1 used must not make 3.

**Setup:** B1's plan with `sessionsReturned = 1` (SU-68 done once) and two sessions ≥ 48 h out.

**Steps:** at once, return session A and session B (different occurrence ids, different keys).

**Expect:** exactly one succeeds (`sessionsReturned = 2`); the other refused with the cap code (record; SU-69 names the guard). `planEndsAt` extended once.

**Probe further:** the refused page: does it say "you've used both returns"?

## CC-22 — The expert declines a proposal as it expires `[sweep]`

**Why it matters:** decline and expiry both restore; doing both must not duplicate or lose the session.

**Setup:** B1 proposes a time on a B1 booking (CO-47 shape, waits for H1). Owner-approved: set the request's `expiresAt` to `now() - 1 minute`.

**Steps:** H1 declines in the UI while the owner runs `reschedule-proposals` at the same moment.

**Expect:** one terminal status (`DECLINED` or `EXPIRED`); the original time restored once (one live occurrence); one notification set. The loser is a no-op or a typed `409` `PROPOSAL_NOT_OPEN`.

**Probe further:** which word does B1 see, "declined" or "expired"? Is the email consistent with the bell?

## CC-23 — The client pays as the pay link lapses `[sweep]`

**Why it matters:** a link paid in its last second must not be expired by the sweep.

**Setup:** CO-25's link; needs a gateway or webhook replay. Owner-approved: set `Payment.expiresAt` to 30 s from now.

**Steps:** the owner posts the capture just before `expiresAt` and runs `abandoned-payments` just after.

**Expect:** the captured payment is `SUCCEEDED`, the booking confirmed; the sweep skips it (it re-checks status before expiring). If the capture arrives **after** the sweep expired the link, it is refunded (MO-66 pattern). Never `EXPIRED` with money captured and no refund.

**Probe further:** B1's view when the link page is opened after lapse but before the sweep: can they still pay? Should they?

## CC-24 — Two admin refunds on one payment at once `[local]` `[two-browser]`

**Why it matters:** the refund door reserves under Serializable isolation; two dialogs must not exceed the charge.

**Setup:** a fresh ₹500 S-08 booking by B3. Two AD pages, each with an **Issue refund** dialog for ₹400 (different `Idempotency-Key`s).

**Steps:** submit both at once.

**Expect:** one `Refund` ₹400; the other refused (over the refundable balance) with human copy, nothing written. Total ≤ `amount`. Repeat with ₹200 + ₹200: both succeed (₹400 total).

**Probe further:** the refused dialog: does it show the new balance?
