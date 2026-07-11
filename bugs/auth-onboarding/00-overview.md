# Auth & Onboarding — Overview

## Context

BetterAuth with Prisma; singular `User.role`; nullable profile FKs; onboarding wizard per role; ORG_WORKSPACE early role commit + org wizard; lazy `ConsulteeProfile` on first consumer action; guards `requireOnboarded`; SSO domain enforcement; referral capture on auth paths; cross-tab `auth-broadcast`.

## Known gaps / bugs

- **No true concurrent consultant + consultee role signup** — one role; dual needs via Membership or separate accounts (seed commentary).
- No self-serve “become a consultant too” / role switcher after onboarding.
- Consultant may get lazy ConsulteeProfile for booking others — dashboard routing still one role; UX unclear.
- Onboarding multi-device last-write-wins (see enterprise onboarding race file).
- STAFF/ADMIN invite-only — good; ensure no UI leak.
- Phone unique empty-string hazards mitigated in Zod — stay vigilant.

## Unhappy paths & user psychology

- Expert wants to book another expert as learner — bounced between dashboards or forced second email.
- User abandons onboarding on phone, finishes on laptop with different role intent — overwrite.
- SSO user lands without onboarding complete — confused loops with `requireOnboarded`.
- OAuth on device A; referral on device B lost (referrals pack).

## Questions (handled?)

1. **Permanent one-account-one-role?**  
   - A) Yes + Membership for cross-role needs  
   - B) Role switcher for CONSULTANT↔CONSULTEE  
   - C) Encourage two accounts  

   **Recommendation: A.** Keep one account → one `User.role` and use Membership for cross-role org needs — dashboards and Stream stay coherent.  
   - Not B: a CONSULTANT↔CONSULTEE switcher explodes routing and permission complexity  
   - Not C: two accounts punish referrals, payments, and SSO  

2. **ORG_WORKSPACE personal consultee booking?**  
   - A) Allow via lazy profile  
   - B) Forbid  
   - C) Separate personal user invite  

   **Recommendation: A.** Allow org-workspace users personal booking via lazy `ConsulteeProfile` carefully — experts booking others should not need a second email.  
   - Not B: forbidding personal booking traps org users who also learn  
   - Not C: a separate personal invite is heavy process for SMB  

3. **Phone step-up (#884) first where?**  
   - A) Referral rewards  
   - B) Payouts  
   - C) All new signups  

   **Recommendation: B.** Require phone on payouts first (and referrals in the same wave) — cash-out and credit mint are the highest-leverage fraud gates.  
   - Not A: referrals-only leaves payout cash-out open longer  
   - Not C: OTP on every signup adds conversion friction before money moves  

## High concurrency / multi-device

Onboarding transaction timeout 45s — flaky mobile networks retry carefully. Broadcast helps tabs see login; onboarding state is server-side (good) except local wizard drafts.

## Suggested directions

Product decision on dual-role UX before more Stream/dashboard complexity. CAS on onboarding submit. Deep-link post-SSO to correct unfinished step.
