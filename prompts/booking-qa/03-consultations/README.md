# 03-consultations (CO-)

Every consultation journey: instant and free booking, org-funded and org-hosted booking, request/approval with each approval mode, pay links, decline and expiry, both sides rescheduling, the caps, cancelling at each tier, expert cancels and strikes, parked bookings, the outage rebook and booking again.

| File | Cases | What |
| --- | --- | --- |
| [booking/01-instant-and-free.md](booking/01-instant-and-free.md) | CO-01 – CO-11 | Instant priced booking, cross-zone, checkout refusals, slot taken, idempotent checkout, paused expert, free booking, self-booking, host-side allocation, abandon door, the day after |
| [booking/02-org-funded-and-hosted.md](booking/02-org-funded-and-hosted.md) | CO-12 – CO-19 | Wipro-funded booking, sponsored refusals, personal-but-tagged privacy, sponsor allocation after approval, org-tagged request still by card, LearnPro-hosted booking and earnings, host operator limits, org lists |
| [request-approval/03-request-and-approve.md](request-approval/03-request-and-approve.md) | CO-20 – CO-31 | Request, request refusals and caps, idempotent request, contended time in instant mode, approve via use-requested / manual / auto, unpaid 2-h lead, free request, approval guards, stale tab |
| [request-approval/04-pay-link-decline-expiry.md](request-approval/04-pay-link-decline-expiry.md) | CO-32 – CO-45 | Paying the link, Remind and its limit, lapsed link, withdraw approval, EXPIRED sweep, buyer abandon, decline and its guards, 48-h request expiry, past request, buyer's-eye journey, history, money summary, restore Instant mode |
| [reschedule/05-reschedule-both-sides.md](reschedule/05-reschedule-both-sides.md) | CO-46 – CO-70 | Consultee: auto-confirm, proposal outside hours, accept, keep original, withdraw, "Any time works", 24-h rule, consultee cap, one open request, expiry, original time taken, times taken, idempotent POST, pay link live. Expert: proposal waits, accept, decline, withdraw, `PROPOSAL_AWAITING_CLIENT`, expert cap, counterparty-only respond, expert "Any time works", deadline across zones, decline door refused, history |
| [cancel/06-cancel-tiers-and-expert-cancel.md](cancel/06-cancel-tiers-and-expert-cancel.md) | CO-71 – CO-86 | 100 / 50 / 0 % tiers, frozen 15-min window, quote changed, request and unscheduled cancels, free cancel, org-funded cancel, status-write refusals, cancel with an open proposal; expert cancel (full refund + strike), free booking (no strike), in-progress refusal, cancel during a proposal, 3-strike public notice, org admin and staff cancels |
| [after-the-fact/07-parked-and-rebook.md](after-the-fact/07-parked-and-rebook.md) | CO-87 – CO-93 | Parked after a failed restore, expert resolves it, parked auto-cancel and refund (client vs expert initiated), parked surfaces, outage free rebook, booking again |

**Fixtures:** F-AV1, F-AV5 (OX), S-08, S-09, S-10, S-16, F-BUSY from 01; G-REQ from 02 optional. Each file books its own fixtures (named at the top of the file) so files can run in any order after 01, except: 03-c must precede 03-d (shared approved request, and 03-d's CO-45 restores H1 to Instant mode); reschedule/05 precedes after-the-fact/07.

**Run order:** 01 → 02 → booking/01 → booking/02 → request-approval/03 → request-approval/04 → reschedule/05 → cancel/06 → after-the-fact/07. Run HM-25 (02) after CO-47.

**Environment:** most fixtures need local mock pay (`[local]`). Paying an approval pay link (CO-32) needs Razorpay test mode or an owner-run webhook replay; there's no Mock Pay on `/checkout/pay/[paymentId]`. Sweeps (CO-36, CO-40, CO-55, CO-89, CO-90) are NEEDS-OWNER-RUN off production.

**Mode switch:** request/approval is an expert-wide setting (`ConsultantProfile.bookingMode`). 03-c switches H1 to "Review requests first" and CO-45 switches back. Don't run 04 or 07 for H1 while H1 is in REQUEST mode.

**Salvaged from `prompts/booking-algorithm-tests/`:**

| Old | New |
| --- | --- |
| 001 Tests 1.2–1.9 (request, pre-allocate, decline, direct checkout, manual/auto) | CO-20, CO-25, CO-26, CO-27, CO-38, CO-01 |
| 001 Tests 5.3, 5.4, 5.7 (24-h rule, conflict, cancel) | CO-52, CO-04, CO-71 |
| 002 Phase 2 (request, approve, checkout, decline) | CO-20, CO-25, CO-01, CO-38 |
| 003 Test 4.3 (isAuto + slots, auto wins) | folded into CO-27's probe (record which wins) |
| 007 Phases 1–5 (expert proposal, one live proposal, accept, decline, consultee auto-confirm, respond/withdraw negatives, expiry math) | CO-60, CO-54, CO-61, CO-62, CO-46, CO-66, CO-68 |
| 012 Phases 1–5 (partial allocation) | not consultations (one session either fits or not); see 04 |
| 014 Phases 1, 5, 6 (host-side rule, window length, paused expert) | CO-09, CO-03/CO-21, CO-06 |
| 017 Phases 1–5 (sponsor approval, member can't allocate, allocate after approve, funding not tag, scoped lists) | CO-15, CO-09, CO-15, CO-14/CO-15, CO-19 |
| 020 Phases 3–4 (expert strikes, where they show) | CO-81, CO-85 |
