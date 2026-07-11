# Referrals — Overview

## Context

`ReferralCode` → `Referral` attribution → `ReferralCredit` spend at checkout. Deferred qualify on first paid booking (Serializable, budget gates, program pause). Pending code in localStorage + `/r/[code]` + `?ref=`. Crons expire credits/referrals. Launch economics conservative (₹300/₹300 class defaults; docs may still mention older amounts).

## Known gaps / bugs

- **Cross-device attribution loss:** localStorage pending code does not survive OAuth on another device (documented acceptable).
- Phone step-up anti-sybil (#884) planned, not done.
- Doc/code drift on reward amounts.
- Org-funded checkout credit blocking (#766) must stay enforced everywhere — audit periodically.
- Consultant commission waiver “later phases.”

## Unhappy paths & user psychology

- Friend shares link; user finishes Google auth on desktop without `?ref=` — attribution lost; both angry.
- Farming rings create many accounts — without phone verify, budget cap is main defense.
- Partial refund restores credit usage — user confused why credit returns differently than cash.

## Questions (handled?)

1. **Cross-device attribution?**  
   - A) Server-side cookie / account claim code entry  
   - B) Accept localStorage loss  
   - C) Require code entry post-signup always  

2. **Economics lock for launch?**  
   - A) Keep ₹300/₹300 + caps  
   - B) Ramp referrer to ₹500 later  
   - C) Pause program via config  

3. **Phone verify before credit spend or qualify?**  
   - A) Before qualify  
   - B) Before spend  
   - C) Defer #884  

## High concurrency / multi-device

Apply/qualify use Serializable retries — good. Multi-device signup races on same code should unique-constrain. Budget gate under parallel qualifies needs the serializable path (present).

## Suggested directions

Add post-auth “have a referral code?” field. Reconcile docs with constants. Keep org-funded credit block tested.
