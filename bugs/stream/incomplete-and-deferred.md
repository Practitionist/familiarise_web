# Stream Incomplete & Deferred

## Context

Documented deferrals and dead code around Stream.

## Known gaps / bugs

- Collaborator video roles (host/moderator/speaker) deferred — `docs/collaborators/05-stream-integration.md`.
- Instant `createMeeting()` in `lib/meeting.ts` — no callers.
- Passcode / hostKeys unused.
- Backfill org metadata scripts exist for channels/calls.
- Hard-delete soft-deleted Stream users >30 days — script TODO.
- Channel naming duplication / policy issues in `tasks/stream-comms-issues.md`.
- Maker plan concurrent limits — monitoring unclear (`docs/competition/...` brutal gaps).

## Unhappy paths & user psychology

- Collaborator expects host controls; only primary consultant can end call.
- Support cannot find ad-hoc meeting without MeetingSession row.

## Questions (handled?)

1. **Collaborator roles before host-org GA?**  
   - A) Required  
   - B) After ENABLE_HOST_ORGS  
   - C) Never — host-only end  

2. **Delete dead `createMeeting` or productize instant rooms?**  
   - A) Delete  
   - B) Productize personal rooms  
   - C) Keep internal/admin only  

## High concurrency / multi-device

Deferred roles matter most when multiple experts join the same webinar from different devices.

## Suggested directions

Either schedule collaborator video roles or document “host-only controls” in UI.
