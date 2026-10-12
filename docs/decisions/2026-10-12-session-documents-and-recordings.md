# ADR: Session documents, plan materials and recordings

- **Status**: Accepted
- **Date**: 2026-10-12
- **Related**: [Session documents architecture](../documents/README.md), [Recordings lifecycle and access](../stream/19-recordings-lifecycle-and-access.md), [Recording storage, retention and visibility](2026-10-09-recording-storage-retention-visibility.md) (partly superseded by ADR-11 and ADR-17 below)

This record holds eighteen decisions about the files attached to a booking: how a review thread behaves, when uploads close, how long files live, how they are opened, which pages own which actions, and which recordings a learner of a multi-batch plan may watch. Each decision has its own Status, Context, Decision, Alternatives and Consequences. The 2026-10-09 record stays authoritative for where recordings are stored (pulled into R2), the consent-based discard of declined 1:1 recordings and the platform retention schedule; its visibility rules for webinar and class recordings are superseded by ADR-11, and its treatment of cancelled bookings is refined by ADR-17.

## Decisions

### ADR-01. An expert reply is a new version in the same thread

- **Status:** Accepted (decision 1).
- **Context:** Experts answer a learner's file with notes, a marked-up copy, or both. Replies were once separate documents that showed up under the learner as "Approved" rows. A reply is now a new version, but it is stored `APPROVED`, and several reads display that status.
- **Decision:**
  - A reply is the next version of the thread (`uploadedByRole = CONSULTANT`, `responseToDocumentId` set), labelled "Expert reply".
  - It never shows a review status.
  - The thread's status is derived only from the latest live learner version.
  - The stored enum value is left unchanged, so no schema change is needed.
- **Alternatives considered:**
  - Notes only, with files sent as separate shared documents: this splits one conversation across documents.
  - A separate thread per expert file: same problem, and the learner loses the link between a reply and the draft it answers.
- **Consequences:**
  - One history per document.
  - Every reader must ignore the stored status of expert rows; the server-built thread view (ADR-15) does this in one place.
  - Library status filters read the latest learner version.

### ADR-02. The learner can upload a new version only while the thread is waiting or needs revision

- **Status:** Accepted (decision 2).
- **Context:** The UI allowed revisions during review while the server checked only caps, so an expert could approve a draft that had just been superseded.
- **Decision:**
  - A learner version is accepted only when the latest live learner row is `PENDING` or `NEEDS_REVISION`, never on an expert's shared file.
  - This is enforced inside the existing `FOR UPDATE` transaction.
  - The review write also requires that no newer learner version exists (409 `SUPERSEDED`).
- **Alternatives considered:**
  - Only after "needs revision": too strict, since a learner cannot replace a draft before review starts.
  - Any non-final state: reintroduces the supersede race.
- **Consequences:**
  - "In review" acts as a soft lock that both sides can see.
  - The UI never decides; it renders `allowedActions` from the server.

### ADR-03. Ten learner versions per document; expert replies do not count

- **Status:** Accepted (decision 3).
- **Context:** The cap was 10 rows including replies, which is about five rounds, so experts who annotate used up the learner's budget.
- **Decision:**
  - Cap live learner rows at 10 per thread.
  - `versionNo` keeps counting all rows and may exceed 10.
  - The UI shows "All 10 versions used" instead of a button that fails.
- **Alternatives considered:**
  - 10 rows including replies (the old rule).
  - 20 rows including replies.
- **Consequences:**
  - Expert replies are bounded by the expert's own effort and the review rate limiter.
  - The sidecar uniqueness on `(thread, versionNo)` is unchanged.

### ADR-04. Uploads close 30 days after the last session

- **Status:** Accepted (decision 4).
- **Context:** Uploads stayed open forever on completed bookings on the server, while the learner UI hid them at completion. Neither stated a rule.
- **Decision:**
  - `uploadWindowClosesAt` = last live session end + 30 days. It is computed, not stored, and is checked inside the commit and review transactions.
  - After it closes, the thread is read-only with the reason and date shown.
  - Terminal bookings are read-only immediately.
- **Alternatives considered:**
  - No window.
  - Close at completion: too strict for post-session review, which is the product's value.
- **Consequences:**
  - No column is needed.
  - The workspace and hub show the date.
  - Expert actions also stop at the window (accepted decision D-D).

### ADR-05. Removing a reviewed document goes through the booking's support thread, with a status banner on every thread

- **Status:** Accepted (decision 5).
- **Context:** A reviewed document could not be removed and nothing explained why. Letting the learner delete it would break the history the expert's review refers to.
- **Decision:**
  - "Request removal" sets `removalRequestedAt` on the root and escalates the booking's existing support thread (category `DOCUMENTS`, reason `documents_removal`).
  - Support removes the thread (reason recorded) or declines and clears the flag.
  - Every thread shows a banner naming who acts next: "Waiting for <expert> to review", "<expert> is reviewing", "Removal requested — support will respond".
- **Alternatives considered:**
  - Locked with no path.
  - Learner deletes at any time.
  - Deriving the request from support threads alone, with no flag.
- **Consequences:**
  - One nullable column (ADR-16).
  - No new support model.
  - Support gets a back-office "Remove document" action.

### ADR-06. Session documents are deleted 90 days after the booking ends, by the registered purge job

- **Status:** Accepted (decision 6).
- **Context:** No retention existed. The purge ran through a `jobs/` wrapper outside the cleanup registry and could split a thread by purging its root first.
- **Decision:**
  - Arm 1 of `purge-deleted-documents` tombstones documents 90 days after the last session, or after cancellation, with `removalReason = RETENTION_EXPIRY`.
  - Arm 2 purges tombstones after the grace window, versions before roots, objects before rows.
  - The job is registered in `lib/cron/cleanup-registry.ts`, and the wrapper is deleted.
  - The UI shows "Kept until <date>".
- **Alternatives considered:**
  - Keep indefinitely.
  - One year after the booking ends.
  - A separate retention job.
- **Consequences:**
  - One job and one scheduler (daily Actions calling the route).
  - The reason is recorded on every tombstone.
  - The storage reconcile shares the grace constant.

### ADR-07. "Open" is a new tab on a same-origin viewer route; Download uses the JSON preflight

- **Status:** Accepted (decision 7).
- **Context:** Opening through a preflight and then `window.open` on a 60-second storage link navigated the current tab away, because `window.open` with `noopener` returns `null`. The opened tab also broke on reload after a minute.
- **Decision:**
  - `/files/documents/[documentId]` and `/files/materials/[materialId]` authorise and sign on every load, embed the file, and render friendly HTML on any error.
  - "Open" is a plain link.
  - There is no in-drawer preview.
  - Download keeps `?format=json` so errors return to the page.
- **Alternatives considered:**
  - Preflight then signed URL (the old approach).
  - In-app preview only.
  - Proxying the bytes through a function: this hits function response limits and doubles bandwidth.
- **Consequences:**
  - Middle-click and copy-link work.
  - A reload re-signs.
  - The preview component and the open helpers are deleted.

### ADR-08. The appointment page is a hub; documents and recordings get dedicated per-appointment pages

- **Status:** Accepted (decision 8).
- **Context:** Review work did not fit the details page's narrow aside. Three roles each rendered documents differently, and the libraries duplicated actions.
- **Decision:**
  - The details page shows snapshot cards for Documents, Materials and Recordings.
  - `…/appointments/[id]/documents` holds threads, bulk upload and review.
  - `…/appointments/[id]/recordings` holds sessions, parts and the player.
  - Libraries are read-only indexes that link to these pages.
- **Alternatives considered:**
  - The Session page owns every action.
  - Both the page and the libraries act.
  - The library owns everything.
- **Consequences:**
  - Two new routes per role tree.
  - Several list and drawer components are deleted.
  - The details page stays light.

### ADR-09. Documents work for trials through one shared party resolver

- **Status:** Accepted (decision 9).
- **Context:** The UI offered documents on trials, but every document route repeated a consultation-or-subscription `OR` with no trial arm, so trials always got 404.
- **Decision:** `resolveDocumentParty(db, appointmentId, userId)` returns the caller's role and the booking facts (terminal state, window, retention dates). Every document route, the viewer page and the workspace page use it.
- **Alternatives considered:**
  - Hide documents on trials.
  - Add a trial arm to each route separately.
- **Consequences:**
  - Party logic exists once and accepts `tx`.
  - `isBookingTerminal` gains a trial arm.

### ADR-10. Libraries are grouped by appointment, with person, kind and status filters

- **Status:** Accepted (decision 10).
- **Context:** Three list implementations used different filters and date definitions, and the expert could not see whose turn it was.
- **Decision:**
  - The consultant, consultee and org libraries use `LibraryBrowser`, grouped by appointment.
  - Filters are the other person, kind, status (including "Your turn"), date and search, all in the URL.
  - Collaborators and co-hosts see only appointments they are a party to.
- **Alternatives considered:**
  - Flat file lists.
  - Keep the three implementations.
- **Consequences:** The person facet is returned by the library read, and the status filter reads the latest learner version.

### ADR-11. Recordings across runs and batches: own batch by session, with catch-up for missing sessions

- **Status:** Accepted (decision 11, Option B).
- **Context:**
  - A plan has runs (webinars) or batches (classes). Each has one appointment with sessions (`ordinal`), and each session may have several recordings.
  - Today playback allows every batch of a class plan, the library lists other runs as separate cards linking to pages the learner cannot open, and one API pins classes to the own batch.
- **Decision:**
  - Organise a learner's recordings by their own batch's sessions, as "Part k of n" within a session.
  - A session whose own occurrence ended with no playable recording shows a catch-up from the most recent other batch with the same `ordinal`: classes always, webinars only with `shareRecordingsWithAllAttendees`.
  - Never for upcoming sessions, and never before a late joiner's floor unless the plan allows it.
  - One server rule decides both the list and playback, and links always point at the viewer's own appointment.
- **Alternatives considered:**
  - Own batch only.
  - Catch-up plus an "Other batches" browser (keeps today's breadth); rejected by D-B.
- **Consequences:**
  - Narrows today's class and shared-webinar access to what the learner's batch is missing.
  - No schema change.
  - The playback route gains a slot query.

### ADR-12. Review findings are split by origin

- **Status:** Accepted (decision 12).
- **Context:** The review of the documents and recordings surfaces found defects introduced by the change under review, defects that predate it, and a redesign.
- **Decision:**
  - The pull request carries only what it introduces, plus the architecture direction.
  - Earlier defects and the redesign go to the follow-up issues for documents, recordings, the Session page and file policy.
  - Retention and cleanup get one issue.
  - The design issue holds the whole design.
- **Alternatives considered:** Everything on the pull request, which would block it on unrelated work.
- **Consequences:** The change merges after its must-fix items, and the follow-up issues carry checklists.

### ADR-13. The curriculum position is `AppointmentOccurrence.ordinal`; no new column

- **Status:** Accepted.
- **Context:** Session labels were computed from a list filtered to future sessions, so past recordings read "Session 1" or nothing. Catch-up needs a position that is comparable across batches.
- **Decision:**
  - Use `ordinal`. It is 1-based, inherited by reschedule replacements, and unique among live rows (`schema.prisma:5266-5268`, `check-constraints.sql:25-27`).
  - Titles come from `ClassContent.order` or `SubscriptionContent.order`, falling back to "Session k".
- **Alternatives considered:** A new curriculum-position column on occurrences or recordings.
- **Consequences:**
  - No migration.
  - Voided sessions and their make-ups share a slot.
  - Titles are best-effort because content order is not constrained.

### ADR-14. Supabase Storage for documents and materials, R2 for recordings

- **Status:** Accepted (records the existing design).
- **Context:** Two very different object profiles: small, rarely read files versus large, streamed, long-lived video.
- **Decision:**
  - Keep documents and materials in the private Supabase `documents` bucket with on-demand links.
  - Keep recordings in the private R2 bucket with a server-side pull copy and per-request playback links.
- **Alternatives considered:** One store for everything, in either direction.
- **Consequences:**
  - Two signing helpers, each used everywhere for its kind.
  - Cleanup exists per store: purge and reconcile for documents, retention and asset deletion for recordings, plus the new post-commit deletion on hard delete.

### ADR-15. The server builds the thread view, with `allowedActions`; status is derived and no new enum is added

- **Status:** Accepted.
- **Context:** Threads were grouped on the client. That showed stale feedback under newer versions and let the UI's rules drift from the server's.
- **Decision:**
  - `GET /api/appointments/:id/documents` returns threads with `status`, `banner`, `removal`, `learnerVersions`, `allowedActions` and versions without URLs, built in `lib/documents/thread-view.ts`.
  - "Superseded" is derived, not stored.
- **Alternatives considered:**
  - Keep client grouping.
  - Add a `SUPERSEDED` enum value.
- **Consequences:**
  - One place for state rules.
  - The UI reads, never decides.
  - No enum migration.

### ADR-16. Two nullable columns record removal requests and removal reasons

- **Status:** Accepted (accepted decision D-C).
- **Context:** The removal banner and the recorded removal reason need a visible "removal requested" state and a recorded reason, under the launch schema freeze.
- **Decision:** Add `AppointmentDocument.removalRequestedAt DateTime?` and `removalReason DocumentRemovalReason?` (`USER_REQUEST`, `RETENTION_EXPIRY`, `SUPPORT_ACTION`).
- **Alternatives considered:**
  - Derive the request from support threads.
  - A free-text reason.
- **Consequences:** Additive and nullable. `prisma generate` and a read-only drift check are needed; no `db push`.

### ADR-17. A cancelled booking's files are read-only until the retention date

- **Status:** Accepted (accepted decision D-A).
- **Context:** Documents were hidden on cancellation while recordings stayed playable, and the expert saw a Retry that could never succeed.
- **Decision:**
  - Both parties can open and download documents and watch recordings until "kept until".
  - Uploads, reviews and replies are closed.
  - Both sides see one message.
- **Alternatives considered:**
  - Hide both.
  - Keep the split.
- **Consequences:** The documents list and download routes stop refusing terminal bookings for reads. Writes still refuse.

### ADR-18. The upload window also closes expert reviews and replies

- **Status:** Accepted (accepted decision D-D).
- **Context:** The upload window makes a thread read-only after 30 days. An expert may still have a review open at that moment.
- **Decision:** Read-only for both sides. A review started before the window closes cannot be finished after it.
- **Alternatives considered:** Let the expert finish a started review.
- **Consequences:** One rule, stated on the thread banner with its date.

## References

- Design: [#2111](https://github.com/Practitionist/familiarise_web/issues/2111). Retention and cleanup: [#2112](https://github.com/Practitionist/familiarise_web/issues/2112).
- Follow-ups: [#2083](https://github.com/Practitionist/familiarise_web/issues/2083), [#2084](https://github.com/Practitionist/familiarise_web/issues/2084), [#2085](https://github.com/Practitionist/familiarise_web/issues/2085), [#2086](https://github.com/Practitionist/familiarise_web/issues/2086).

> Status: the behaviour in ADR-01 to ADR-11 and ADR-15 to ADR-18 lands with the documents & recordings mega-fix PR; ADR-12 to ADR-14 describe process and existing design.

## Deprecated & Superseded Approaches

| Superseded approach | Why it was superseded | What to do with residue |
|---|---|---|
| Standalone consultant replies with a separate reply dialog | A reply appeared as its own "Approved" document, detached from the draft it answered | Nothing left; the remaining "Approved" display on expert rows goes with ADR-01 |
| Expert rows displayed with their stored `APPROVED` status | Experts do not approve their own files | Readers ignore it; do not migrate the enum value |
| Preflight, then `window.open` on the signed link | `window.open` with `noopener` returns `null`, so the fallback navigated the current tab away | Delete the helpers; "Open" is a plain link (ADR-07) |
| In-drawer preview pane | Duplicated the viewer and had its own error paths | Delete with the drawer |
| Stored time-limited links in `fileUrl` | Went stale an hour after upload | Write the canonical route path and stop returning the field |
| The Resources aside as the place for document work | Review rounds and bulk upload do not fit a narrow aside | `ResourceSnapshot` cards (ADR-08) |
| "The Session page owns every action" | The owner preferred a hub with dedicated pages | None in code |
| Legacy upload modal `DocumentUpload` | A second upload and list implementation | Point its caller at the workspace and delete it |
| Three list shells for libraries | Different filters and date definitions for one concept | `LibraryBrowser` (ADR-10) |
| Regex-derived library links from `backHref` | Fragile and unscoped to the booking | Explicit `hrefs` |
| "Session N" from the still-joinable list | Past recordings never matched a session | Use `ordinal` (ADR-13) |
| Each other run as its own library card | Tripled lists and links to pages the learner cannot open | Catch-up slots (ADR-11) |
| Three different cross-run recording rules | The list, the API and playback disagreed | One slot-aware rule (ADR-11) |
| Version cap over all rows | Expert replies used up the learner's budget | Count live learner rows only (ADR-03) |
| Client-side thread grouping | Stale feedback and drifted rules | Server-built thread view (ADR-15) |
| Purge as a `GITHUB_OUTPUT` wrapper outside the registry | One registered implementation per job | Register it and delete the wrapper (ADR-06) |
| Purge by tombstone age only | Purging a root first re-rooted surviving versions | Versions before roots (ADR-06) |
| Separate 7-day and 30-day grace windows | Two jobs disagreed about when an object is orphaned | One shared constant |
