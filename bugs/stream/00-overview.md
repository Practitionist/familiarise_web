# Stream — Overview

## Context

Stream Chat + Stream Video power messaging and meetings. Lazy `StreamProvider`, server token generation, deterministic call IDs (`slot-{slotId}`), `MeetingSession` 1:1 with slots, webhook lifecycle/recording transfer to Supabase. Circuit breaker and idle deferred connect protect dashboard performance.

Canonical: `docs/stream/`, `lib/stream-client.ts`, `app/meetings/`.

## Known gaps / bugs

- **P0 security:** token server actions accept arbitrary `userId` without session bind (#400).
- All app roles mapped to Stream `"admin"` — weak channel permission model.
- Client-side call creation; app `validate-access` ≠ Stream-enforced membership.
- Multi-tab duplicate participation allowed.
- Collaborator video roles deferred; passcode/hostKeys unused.

## Unhappy paths & user psychology

- User joins from phone and laptop — echo, double tiles, “who is speaking?”
- Token leak / forged action mints another user’s chat identity.
- Recording expected on 1:1 consultation but disabled by plan rules — surprise.

## Questions (handled?)

1. **Prioritize #400 before any growth marketing?**  
   - A) Yes — hard gate  
   - B) Mitigate with network controls only  
   - C) Move tokens to session-bound API this sprint  

2. **Single active device per call?**  
   - A) Enforce  
   - B) Allow multi-device  
   - C) Warn only  

## High concurrency / multi-device

Deterministic call IDs + DB unique help join races. Stream concurrent usage and Maker plan limits need monitoring.

## Suggested directions

Fix token binding and Stream role mapping before expanding chat surfaces.
