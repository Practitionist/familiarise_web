# Collaborators — Overview

## Context

Unified `Collaborator` for webinar/class plans: invite, accept, revenue bps (host ≥10%, collaborators ≤90%), permissions booleans, Stream collab channels, multi-party earnings and refund tests. Availability overlay APIs exist. Consultation co-consultant out of scope (1:1). Podcast collaborators not modeled.

## Known gaps / bugs

- Permission flags richer in schema than API enforcement surface — audit needed.
- XOR webinar/class plan IDs app-enforced only (no DB check).
- Collaborator video host/moderator roles deferred (stream pack).
- Org-hosted expert collaborator path depends on `ENABLE_HOST_ORGS`.
- Legal revenue-share agreements not captured in product ToS flow.

## Unhappy paths & user psychology

- Collaborator accepts, expects to end call / approve payments; buttons missing.
- Host changes split after sessions sold — historical earnings frozen but future surprise.
- Concurrent invites push total share >90% — Serializable should block; UI may not explain.
- Removed collaborator still in Stream channel until sync — awkward messages.

## Questions (handled?)

1. **Co-consultation for 1:1 on roadmap?**  
   - A) Never  
   - B) Later product  
   - C) Soft co-host without revenue split  

2. **Can collaborators schedule?**  
   - A) Host-only forever  
   - B) Permission-gated  
   - C) Role-based (moderator yes)  

3. **Capture revenue share legal assent?**  
   - A) Clickwrap on accept  
   - B) External contract only  
   - C) Org MSA covers  

## High concurrency / multi-device

Invite Serializable + reactivate declined rows — solid. Accept/remove from two devices should CAS status. Earnings per payment snapshot avoids mid-flight split edits affecting past.

## Suggested directions

Audit permission enforcement vs UI. Document host-only video controls until roles ship. Clickwrap on invite accept.
