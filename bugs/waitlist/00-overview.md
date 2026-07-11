# Waitlist — Overview

## Context

For full webinars/classes: `WAITING → NOTIFIED → BOOKED|EXPIRED|CANCELLED|SKIPPED`. Priority queue (priority DESC, joinedAt ASC); CAS batched notify on slot opening; Resend emails with deep links; expiration crons. Unique per user per webinar/class. Org scope on GET.

## Triage verdict (2026-07-12)

Triaged 2026-07-12 against real code (3 verifier agents cross-checked every claim); fix wave PRs #981–#994 shipped. This dossier's claims map as follows:

| Claim (short) | Verdict |
|---|---|
| NOTIFIED users get no soft-held seat | ✅ FIXED-BY #986 (seat-hold-after-notify) |
| Join is check-then-create outside transaction (ugly 500) | ✅ FIXED-BY #986 (tx + friendly 409) |
| Slot assignment / notify fan-out race | 🔵 TRACKED #834 (CAS shipped); seat-hold-after-notify gap ✅ #986 |
| Consultation waitlist not implemented | 🟡 LEGIT-DEFERRED |
| VIP `priority` schema-only, weak admin UX | 🟡 LEGIT-DEFERRED |
| `preferences` JSON unused; `organizationId` backfilled later | 🟡 LEGIT-DEFERRED |
| Novu waitlist workflows secondary to email | 🟡 LEGIT-DEFERRED |

## Known gaps / bugs

- NOTIFIED users do **not** get a soft-held seat — first-come at checkout can still lose.
- Consultation waitlist not implemented.
- VIP `priority` field schema-only; weak admin UX.
- Join is check-then-create outside transaction — rare double-join hits unique constraint (OK) but ugly error.
- `preferences` JSON unused; `organizationId` sometimes backfilled later.
- Novu waitlist workflows secondary to email.

## Unhappy paths & user psychology

- User gets “spot available,” races to pay, seat gone — betrayal after notification.
- 48h window too long for hot events (holds hope) or too short for India SMB schedules.
- Join on two devices — second fails; first device doesn’t show clear “already waiting.”
- Email link on phone requires sign-in; desktop session different — friction.

## Questions (handled?)

1. **Reserve inventory for NOTIFIED users?**  
   - A) Soft lock N minutes  
   - B) Keep FCFS checkout  
   - C) Tokenized one-click claim  

   > 🎯 Locked: A — soft seat-hold for NOTIFIED head-of-queue shipped in #986.


   **Recommendation: A.** Soft-lock seats for NOTIFIED users for N minutes so “spot available” is not a race that feels like betrayal.  
   - Not B: pure FCFS after notify burns trust on hot webinars  
   - Not C: tokenized one-click claim is more build than a soft hold needs  

2. **48h notify window?**  
   - A) Keep  
   - B) Shorten for webinars  
   - C) Configurable per plan  

   **Recommendation: B.** Shorten the notify window for hot webinars so hope does not sit open while inventory churns.  
   - Not A: a flat 48h hold is too long for high-demand events  
   - Not C: full per-plan config can wait until conversion data exists  

3. **SMS/WhatsApp for spot-available?**  
   - A) Before scale events  
   - B) Email only  
   - C) Novu multi-channel later  

   **Recommendation: B.** Keep spot-available on email first — Resend already works and avoids SMS/WhatsApp consent cost.  
   - Not A: SMS before scale adds cost and DPDP consent surface early  
   - Not C: Novu multi-channel is fine later, not the launch path  

## High concurrency / multi-device

Slot opening CAS is solid under fan-out. Multi-device accept of same notification should be idempotent. Checkout still needs booking locks.

## Suggested directions

Soft-hold for NOTIFIED head-of-queue. Track NOTIFIED→BOOKED conversion metric.
