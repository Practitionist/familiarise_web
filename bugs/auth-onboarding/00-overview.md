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

2. **ORG_WORKSPACE personal consultee booking?**  
   - A) Allow via lazy profile  
   - B) Forbid  
   - C) Separate personal user invite  

3. **Phone step-up (#884) first where?**  
   - A) Referral rewards  
   - B) Payouts  
   - C) All new signups  

## High concurrency / multi-device

Onboarding transaction timeout 45s — flaky mobile networks retry carefully. Broadcast helps tabs see login; onboarding state is server-side (good) except local wizard drafts.

## Suggested directions

Product decision on dual-role UX before more Stream/dashboard complexity. CAS on onboarding submit. Deep-link post-SSO to correct unfinished step.
