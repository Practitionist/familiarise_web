# Recordings & Webhooks

## Context

Webhook route verifies HMAC; handles recording lifecycle, session end, participant join/leave, moderation flags. Recordings start on STREAM_S3 (URL expiry ~14 days) and transfer to Supabase per plan. Jobs transfer expiring, mark expired, cleanup old. Slot completion updated on session/call end.

## Known gaps / bugs

- Consultation/subscription recording often disabled by design — product expectation mismatch.
- Transfer failures alert after retries; files >500MB unsupported.
- Missing MeetingSession for webhook → logged no-op (orphan calls invisible).
- #471/#472 no-show/overrun may not fully consume attendance yet.
- Org calls export DB-backed; live Stream query for orphans incomplete.

## Unhappy paths & user psychology

- User expects download after 1:1; button missing — trust hit.
- Recording shows in Stream briefly then URL expires before transfer — “lost evidence” in disputes.
- Consent for recording not obvious in Setup — legal risk.

## Questions (handled?)

1. **Enable 1:1 recording with explicit consent?**  
   - A) Opt-in per session  
   - B) Plan flag only for webinar/class  
   - C) Org-policy forced recording  

2. **Dispute evidence retention default?**  
   - A) Align with `streamRecordingRetentionDays` + legal hold  
   - B) 14 days max always  
   - C) Transfer-all immediately  

3. **Webhook sweeper for Stream (parity with Razorpay)?**  
   - A) Replay unprocessed  
   - B) Rely on Stream retries only  
   - C) Nightly reconcile vs Stream API  

## High concurrency / multi-device

Duplicate recording events should be idempotent. Two hosts starting record from two devices — need clear single controller UX.

## Suggested directions

Consent copy in MeetingSetup. Monitor transfer failure alerts during pilot.
