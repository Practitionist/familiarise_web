# ADR: Stream receives an allowlisted user payload, and the existing sync scrubs older copies

- **Status**: Accepted on 2026-11-05 by the owner. Ships in the pull request that adds this record.
- **Date**: 2026-11-05
- **Author**: Platform engineering
- **Related**: [Stream user management](../stream/07-user-management.md), [Channel lifecycle](../stream/17-channel-lifecycle.md), [Chat and video system HLD](../start-here/06-chat-and-video-system-hld.md), [Background recovery](../stream/09-background-sync.md), issue #2525 ("Stream channel payloads expose every member's email to other members")

## Context

Stream returns a user's stored fields to every member of a channel the user belongs to, so anything we put on a Stream user is visible to that user's co-members. Before this record, `upsertUserToStream` and `upsertUsersToStream` (`actions/stream/chat/user.action.ts`) selected `email` from Postgres and sent it to Stream as part of the user object. A consultant's client could therefore read the consultant's email from the channel payload, and in a class or webinar channel every attendee could read every other attendee's email. The owner treats this as a P1 privacy defect and a breach of DPDP data minimisation: the chat product needs a display name, an avatar and a role, and nothing else.

The earlier mitigation, `stripStreamUserEmails` in the same file, only ever removed `email` from the objects that our own server actions return to the browser. It did not touch what was stored at Stream, so the browser SDK, which talks to Stream directly, still received the email. The live check through the Stream MCP confirmed that real users carry `custom.email`.

Two things had to change: stop sending the field, and remove the copies already stored. Nothing in the app reads an email back from Stream. The emails shown in chat screens come from Prisma through `app/api/stream/search-consultees` and `app/api/stream/channels/search-appointments`, so removing the Stream copy loses nothing.

## Decision

1. **One allowlisted payload.** `toStreamUser()` in `lib/stream/user-payload.ts` is the only builder of a Stream user object. It returns exactly `{ id, name, image?, role }`: the name falls back to the id, the image is omitted when empty, and the role is `mapRoleToStream(role)`. Both upsert actions select only `id`, `name`, `image` and `role` from Prisma, so the email never enters the function. Tests in `__tests__/stream/user-actions.test.ts` assert the exact object passed to `upsertUser` and `upsertUsers`.
2. **The existing `stream-sync` job scrubs older copies.** `performStreamUserSync` (`scripts/stream/stream-sync.ts`) already reads up to five pages of 100 Stream users per run. On each page it now calls `staleContactFields()` for every user that is not deleted in Stream and not queued for hard delete. For a user that still holds a field in `STREAM_CONTACT_FIELDS` (today `["email"]`), it sends one `partialUpdateUsers` call per page with `{ id, unset: ["email"] }` for those users. A dry run counts the users and writes nothing.
3. **The summary reports it.** `SyncSummary` gains `totalContactFieldsScrubbed` and `totalFailedScrubs`. A failed `partialUpdateUsers` call moves that page's count from scrubbed to failed, sets `success` to false, and logs one line at the end of the run rather than one per user or per page. It also stops the run and holds the checkpoint at the start of that page, so the next run retries those users instead of leaving them until the cursor wraps; the page's deletions have not been sent at that point, so the replay sends none twice.
4. **`stripStreamUserEmails` stays.** Users who have not yet been scrubbed still hold an email at Stream until the sync reaches them, and the response path must keep hiding it from the browser in the meantime. It becomes removable once a post-release check shows no remaining `custom.email`.
5. **Dead types removed.** The unused `StreamChatUser` type and the empty placeholder augmentations in `types/stream-chat.d.ts` are deleted. `CustomUserData.email` stays only so the sync can name the field.

## Alternatives considered

| Alternative                                            | Why it was rejected                                                                                                                                                                                                                                                                    |
| :----------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A one-off CLI script that scrubs every Stream user     | It needs a human to run it at the right moment, pages the whole roster again (an extra read cost), and does nothing if a later change reintroduces the field. The owner chose autopilot.                                                                                               |
| A new registry job for the scrub                       | A second job would walk the same Stream roster that `stream-sync` already pages, double the reads, and add a schedule, a lease and a freshness requirement for something that is a no-op once clean. AGENTS.md rule 2 also rules out speculative machinery that is dead after one run. |
| Rely on re-upsert only (stop sending, wait)            | A re-upsert only reaches users the app happens to upsert again. A user who is never upserted again keeps the old field indefinitely, and nothing proves the removal.                                                                                                                   |
| Strip emails only on our responses (the earlier state) | The browser SDK talks to Stream directly, so the stored field stays visible to co-members.                                                                                                                                                                                             |

The scrub is a reconciliation across a vendor boundary, which AGENTS.md rule 3 permits. No Postgres constraint can govern what Stream stores.

## Consequences

- Users upserted from the release onward are sent without an email.
- Existing users are cleaned by the scheduled `stream-sync` job (`STREAM_LIFECYCLE_JOBS` in `lib/cron/schedule.ts`), which runs inside its 08:00 to 11:00 UTC window with a five-page slice and a checkpoint per run. A full roster pass therefore takes as many daily windows as the roster needs. It costs no extra Stream reads, and once every user is clean it writes nothing.
- The same job catches a future regression that stores a contact field again.
- Previews refuse background jobs, so the scrub runs only after release.
- Adding a new allowed Stream user field means editing `toStreamUser()`; adding a new contact field to scrub means extending `STREAM_CONTACT_FIELDS`.

## Verification

- Jest: `__tests__/stream/user-actions.test.ts` (exact payloads), `__tests__/stream/stream-sync-exclusions.test.ts` (scrub of a leaky user, no write for a clean user, dry-run count only, skip of deleted or hard-delete users, a failed scrub reported in the summary instead of thrown).
- After release and at least one full sync pass, query users through the Stream MCP (`chat_query_users`) and confirm that none has `custom.email`. When that holds, `stripStreamUserEmails` can be deleted in a follow-up.

## Deprecated & Superseded Approaches

- **Sending `email` in the Stream user upsert.** Removed; `toStreamUser()` is the only payload builder.
- **`stripStreamUserEmails` as the privacy control.** It only ever filtered responses. It remains as a safety net until the scrub has run, then it is redundant.
- **The `StreamChatUser` type.** Deleted; it described the old payload and had no readers.
