# DPDP, Privacy & Erasure

## Context

`ConsentArtifact` with purpose codes; signup stamps primary + Stream processing; org consent UI; Stream upsert gated; org DSAR export jobs; admin-mediated erasure scrub; cookie preferences; consent retention sweeper; breach 72h alert cron. User `termsAcceptedAt` / `privacyAcceptedAt` on onboarding.

## Known gaps / bugs

- No consumer self-serve `/api/me` data export or delete.
- Consent withdrawal cascade incomplete (marketing processors, full Stream purge).
- Multilingual notices not implemented.
- Breach model approximates single 72h clock; law wants immediate intimation + detailed report.
- Doc drift: some headers still call `checkConsent` a stub — it is fail-closed live.
- GDPR DPA pack with processors not productized.

## Unhappy paths & user psychology

- User withdraws consent in org UI; still gets marketing email — rage + regulator complaint.
- Erasure requested; finance retention keeps payment rows scrubbed — user thinks “not deleted.”
- EU user signs up; no GDPR-specific notice — future enforcement risk.

## Questions (handled?)

1. **Consumer DSAR before May 2027?**  
   - A) Self-serve this year  
   - B) Admin-only until Phase 3  
   - C) Email form + SLA cron  

2. **India-only DPDP for v1 vs accept EU users?**  
   - A) Geo-block EU/UK  
   - B) Accept with GDPR pack  
   - C) Soft accept; fix later  

3. **Recording retention default vs privacy policy promise?**  
   - A) Align copy to `streamRecordingRetentionDays`  
   - B) Shorten platform default  
   - C) Per-session user choice  

## High concurrency / multi-device

Consent updates from two devices should last-write with audit. Erasure must invalidate sessions everywhere (`auth-broadcast` / session generation).

## Suggested directions

Ship consumer erasure request tracking UI even if processing stays admin. Fix consent withdrawal side effects for email/Novu.
