# Video Calls & Multi-Device

## Context

Join: lazy meeting create with `slot-{id}` → `/meetings/[id]` → validate-access → Setup → `call.join()`. Host end via consultant EndCallButton. Attendance upserted from webhooks (`MeetingAttendance` per user, not per device). Join windows: consultee ~10 min early, consultant ~15.

## Known gaps / bugs

- Client `getOrCreate` can create Stream call before DB row — orphan call window if DB fails.
- Multi-tab: multiple `user_session_id`s — echo, double billing risk on Stream concurrent.
- Meeting unmount `leave()` can fight another tab still in call.
- `useGetCallById` fallback may create calls even when access story is subtle.
- Consultee path still static-imports SDK (bundle debt #248 partial).
- Passcode / hostKeys in schema unused.

## Unhappy paths & user psychology

- iPad + phone both join; audio feedback ruins session; consultee blames consultant.
- Host ends on one device; other device shows rejoin loop.
- Late join after endedAt set — confusing empty room vs blocked UI.
- Knowing call ID + stolen token bypasses page gate (ties to #400).

## Questions (handled?)

1. **Create all calls server-side with Node SDK?**  
   - A) Yes — membership + roles server-defined  
   - B) Keep client getOrCreate  
   - C) Hybrid: server create, client join only  

2. **Multi-device policy?**  
   - A) Kick older session  
   - B) Allow; show “you’re in this call elsewhere”  
   - C) Soft warn in Setup  

3. **Enforce call membership in Stream, not only validate-access?**  
   - A) Stream call members required  
   - B) App gate enough  
   - C) Backstage + waiting room  

## High concurrency / multi-device

Concurrent joins same slot: DB unique + P2002 handler. Webhook join storms: idempotent attendance upsert; joinCount may inflate on replay.

## Suggested directions

Server-side call create + single-session policy decision. Use attendance for #471 no-show.
