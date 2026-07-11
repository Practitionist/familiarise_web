# Cancel, Reschedule & No-Show

## Context

Cancel: CAS-guarded transitions (`lib/booking/transitions.ts`), soft-cancel slots, policy refund for consultation/subscription after commit, waitlist open for events. Reschedule: 24h minimum notice, marks slots tentative, no new charge, consultant re-allocates. No-show: **not automated** (#471); auto-complete cron marks COMPLETED/UNVERIFIED; Stream attendance is foundation data.

## Known gaps / bugs

- No automated consultant/consultee no-show → refund/credit.
- Partial subscription reschedule status semantics wrong (#448).
- Docs outdated on who may cancel (code requires participant/privileged).
- Cancel preserves appointment rows for audit — calendars must respect `completionStatus` or show ghosts.
- Refund policy docs mention full refund on consultant no-show without code path.

## Unhappy paths & user psychology

- Consultee waits 15 minutes on empty call; expects auto-refund; must fight support.
- Consultant cancels last-minute; consultee already took leave from work — policy % feels unfair without clear pre-booking disclosure.
- Reschedule under 24h blocked; user tries from two devices hoping one slips through.
- Webinar cancel frees seats; waitlist notified; original payer still sees “cancelled” and rebooks same seat race.

## Questions (handled?)

1. **No-show definition for automation?**  
   - A) No MeetingAttendance join within N minutes of start  
   - B) Manual only via SupportIssueType  
   - C) Consultant-confirmed no-show button + consultee contest window  

2. **Cancellation policy snapshot — show at checkout prominently?**  
   - A) Mandatory acknowledge checkbox  
   - B) Link in footer only  
   - C) Dynamic policy by plan tier with examples  

3. **Reschedule under 24h — paid exception or never?**  
   - A) Never (current)  
   - B) Paid change fee  
   - C) Consultant discretion override  

## High concurrency / multi-device

Cancel vs webhook: CAS — one wins. Cancel vs reschedule: `lockAppointment` (5 min). Multi-tab cancel double-submit should no-op after first success.

## Suggested directions

Ship #471 using existing `MeetingAttendance`. Align refund policy copy with automation reality until then.
