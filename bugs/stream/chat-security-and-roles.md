# Chat Security & Roles

## Context

Channels: DMs (`dm-…`), webinar/class team channels, collab channels, legacy consultation/subscription names. Server creates/syncs channels; org tagging on custom data. DPDP consent gates Stream user upsert. Unread badges read client singleton.

## Known gaps / bugs

- `chatTokenProvider(userId)` / related actions not proving `session.user.id === userId` (#400).
- `mapRoleToStream()` maps CONSULTEE (and others) to Stream `admin`.
- Consultee↔consultee and consultant↔consultant chat policy incomplete (`tasks/stream-comms-issues.md`).
- Docs claim token issuance verifies user existence — code may not.
- In-memory server caches ineffective across serverless instances (perf, not auth).

## Unhappy paths & user psychology

- Blocked user still reachable via another channel type.
- Org admin exports chat metadata expecting redaction; PII slips.
- Consent withdrawn mid-thread — upsert fails; existing WS session degrades oddly.

## Questions (handled?)

1. **Stream role model?**  
   - A) `user` / channel_member with typed grants  
   - B) Keep admin for simplicity (reject)  
   - C) Separate Stream apps for consult vs org  

2. **Consultee↔consultee messaging?**  
   - A) Forbid  
   - B) Allow in class/webinar only  
   - C) Allow DMs with report button  

3. **Token API shape?**  
   - A) Authenticated route; ignore body userId  
   - B) Server action with assertSession  
   - C) Short-lived call-scoped tokens only  

## High concurrency / multi-device

Each tab may hold StreamChat instance; logout must disconnect. Cross-tab unread can desync until refresh.

## Suggested directions

Ship #400 + demote Stream roles. Add abuse report path before opening broader DM graph.
