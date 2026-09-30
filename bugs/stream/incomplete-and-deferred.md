# Stream Incomplete & Deferred

> **⚠️ HISTORICAL SNAPSHOT — read the code, not this file.**
> This dossier was triaged on **2026-07-12** and the verdict tables below record
> the state _at that date_. Several "LEGIT-DEFERRED" verdicts have since been
> fixed and several "Known gaps" have since been closed, so a reader who treats
> this page as a description of the current system will be misled.
>
> Canonical and current: `docs/stream/` (start at `docs/stream/README.md`).
> Where this file and the code disagree, the code is correct and this file is
> the bug. Superseded claims are struck through or annotated inline; the verdict
> table is left as-written because it is the historical record.

## Context

Documented deferrals and dead code around Stream.

## Triage verdict (2026-07-12)

Triaged 2026-07-12 against real code (3 verifier agents cross-checked every claim); fix wave PRs #981–#994 shipped. This dossier's claims map as follows:

| Claim (short)                                                            | Verdict                                |
| ------------------------------------------------------------------------ | -------------------------------------- |
| Collaborator video roles (host/moderator/speaker) deferred               | 🟡 LEGIT-DEFERRED                      |
| Instant `createMeeting()` in `lib/meeting.ts` has no callers (dead code) | ✅ FIXED-BY #983 (deleted)             |
| Passcode / hostKeys unused                                               | 🟡 LEGIT-DEFERRED                      |
| Backfill org metadata scripts exist for channels/calls                   | 🟡 LEGIT-DEFERRED (tooling, not a bug) |
| Hard-delete soft-deleted Stream users >30 days (script TODO)             | 🔵 TRACKED #535                        |
| Channel naming duplication / policy issues                               | 🟡 LEGIT-DEFERRED                      |
| Maker plan concurrent limits — monitoring unclear                        | 🟡 LEGIT-DEFERRED                      |

## Known gaps / bugs

- Collaborator video roles (host/moderator/speaker) deferred — `docs/collaborators/05-stream-integration.md`.
- ~~Instant `createMeeting()` in `lib/meeting.ts` — no callers.~~ **No longer a gap: deleted in #983.** `lib/meeting.ts` no longer exports it, and room creation is `provisionAppointmentMeeting` in `actions/stream/meetings/meeting.action.ts`.
- Passcode / hostKeys unused.
- Backfill org metadata scripts exist for channels/calls.
- Hard-delete soft-deleted Stream users >30 days — script TODO. The sync still soft-deletes (`user: "soft"`, `messages: "soft"`), so this TODO stands.
- Channel naming duplication / policy issues in `tasks/stream-comms-issues.md`.
- Maker plan concurrent limits — monitoring unclear (`docs/competition/...` brutal gaps).

## Unhappy paths & user psychology

- Collaborator expects host controls; only primary consultant can end call.
- Support cannot find ad-hoc meeting without a `Meeting` row. _(The model was renamed from the slot-era `MeetingSession`; the row is still the thing support needs, and it is written before the Stream call is minted so a call with no row is invisible to every reconciler.)_

## Questions (handled?)

1. **Collaborator roles before host-org GA?**
   - A) Required
   - B) After ENABLE_HOST_ORGS
   - C) Never — host-only end

**Recommendation: B.** Ship collaborator video roles with host-org GA when multi-expert economics actually need them.

- Not A: Pulls Stream role work ahead of sponsor-first sequencing.
- Not C: “Never” contradicts webinar/class collaborator product already in schema.

2. ~~**Delete dead `createMeeting` or productize instant rooms?**~~ **Answered: deleted (#983).** The question is closed; instant rooms remain unbuilt by design.
   - A) Delete
   - B) Productize personal rooms
   - C) Keep internal/admin only

**Recommendation: A.** Dead entry points confuse ownership of the `Meeting` row and orphan-call debugging — delete until productized.

- Not B: Instant rooms expand surface before #400 and server-side create land.
- Not C: “Internal only” still leaves unowned code paths support will hit.

## High concurrency / multi-device

Deferred roles matter most when multiple experts join the same webinar from different devices.

## Suggested directions

Either schedule collaborator video roles or document “host-only controls” in UI.
