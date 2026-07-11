# Feedback & Reviews — Overview

## Context

Two concepts: **platform Feedback** (user → product, staff workflow) and **ConsultantReview** (consultee → consultant rating). Reviews surface on explore profiles; staff can moderate/delete. Novu notifies on feedback and new reviews. Moderation reports are a separate adjacent system.

## Known gaps / bugs

- Review create does **not** reliably denormalize `ConsultantProfile.rating` (delete path recalculates; create may not) — explore sort drift.
- No unique constraint per consultee–consultant pair — spam/multiple reviews possible.
- No completed-booking eligibility gate — unverified praise or revenge reviews.
- Review POST may not prove `consulteeProfileId` belongs to session user (ownership hole).
- Public consultant search can match on **email** — PII leak risk on explore API.

## Unhappy paths & user psychology

- Competitor creates five 1-star reviews without booking — trust collapse.
- Consultant rating stuck high after many new low reviews until someone deletes.
- User leaves feedback expecting product reply; ticket-like status unclear.

## Questions (handled?)

1. **One review per pair, gated on completed paid session?**  
   - A) Yes — unique + eligibility  
   - B) Allow updates to single review  
   - C) Open reviews; badge “verified booking”  

2. **Rating source of truth?**  
   - A) Live aggregate query  
   - B) Denormalized field with triggers on all mutations  
   - C) Nightly recompute job  

3. **Remove email from public search?**  
   - A) Immediate  
   - B) Admin-only search  
   - C) Hash/obfuscate  

## High concurrency / multi-device

Concurrent creates + deletes race the denormalized rating. Two devices submitting reviews — without unique key both succeed.

## Suggested directions

Gate reviews, fix rating updates on create/update/delete, strip email from public explore search.
