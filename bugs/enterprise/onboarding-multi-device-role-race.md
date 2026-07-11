# Onboarding Multi-Device Role Race

## Context

`User.email` is unique; `User.role` is **singular**. CONSULTANT/CONSULTEE roles commit mainly at final `processOnboardingData`; ORG_WORKSPACE commits earlier at step 0. Two devices, same email, different role wizards, simultaneous submit → **last write wins**. Transaction clears profile FKs and upserts one role’s profile — orphan profile rows possible.

This is the exact unhappy path: firm onboarding on one device as consultant, other device as consultee, both hit submit.

## Known gaps / bugs

- No optimistic locking / version CAS on `User` during onboarding.
- No onboarding mutex (unlike invite accept atomic claim).
- `sessionGeneration` bumps on membership changes, not always on mid-onboarding role flips.
- Chaos suite covers multi-device **login**, not multi-role **onboarding**.
- Orphan `ConsultantProfile` / `ConsulteeProfile` rows can linger after role flip.

## Unhappy paths & user psychology

- Founder starts consultant onboarding on laptop, tries consultee “just to see” on phone, submits both — ends as wrong role with half-filled profile.
- ORG_WORKSPACE step-0 commit on device A; device B still shows consultee steps from cache.
- User thinks they can be both consultant and learner under one email without understanding Membership vs UserRole.

## Questions (handled?)

1. **Is one email = one platform role permanent product law?**  
   - A) Yes — dual needs = Membership LEARNER + CONSULTANT user  
   - B) Allow dual platform roles (schema change)  
   - C) Separate accounts encouraged  

2. **Concurrent onboarding submit — how to handle?**  
   - A) Role lock at step 0 for all roles + CAS on submit  
   - B) Reject second submit if `onboardingCompleted` or role mismatch  
   - C) Accept last-write-wins; cleanup orphans via job  

3. **After role flip, delete unused profiles?**  
   - A) Hard delete unused  
   - B) Soft keep for audit  
   - C) Merge data where possible  

## High concurrency / multi-device

Worst case is simultaneous final submits. Also bad: one device completes while other still editing local wizard state and overwrites later.

## Suggested directions

Add explicit “You started as X on another device” banner via polling `User.role`. Wire CAS on `processOnboardingData`. Add chaos test for dual-role submit.
