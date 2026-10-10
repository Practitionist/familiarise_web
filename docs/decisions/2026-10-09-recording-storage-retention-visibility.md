# ADR: Recordings are pulled to Cloudflare R2, private by default, and deleted on a platform schedule

- **Status**: Accepted
- **Date**: 2026-10-09
- **Author**: teetangh
- **Related**: [Mid-session recording decline](2026-08-13-mid-session-recording-decline.md), [ADR 20: org visibility into member sessions](../enterprise/70-design-decisions/20-org-visibility-into-member-sessions.md)

## Context

A session recording is a stored copy of a conversation that was often about someone's career, health or money. Three questions decide how the platform treats it: where the bytes live, who may watch them, and when they are erased. The earlier answers to those questions had drifted apart.

Storage was a per-plan choice. A consultant picked `STREAM_ONLY` (Stream keeps the file for 14 days) or `PERMANENT` (the platform copies it to its own bucket), and a manual "Transfer" button refused with `UPGRADE_REQUIRED` for the free tier. The copy was meant to run inside a Netlify `after()` callback after the webhook, but that callback shares a 26-second function budget while a recording is on the order of 1 GB, and the destination bucket was Supabase Storage, whose Free plan clamps every object to 50 MB. In practice no recording was ever copied.

Visibility was uneven. Webinar recordings were reachable by anyone with a paid enrollment on the plan, so a buyer of one run could watch every other run. The Stream browser SDK could also list recordings directly because the `user` and `call_member` grants carried `list-recordings`, which bypasses our access checks entirely.

Retention existed only for organizations (`Organization.streamRecordingRetentionDays`, default 90). A personal recording had no erasure date, which conflicts with the storage-limitation principle of the Digital Personal Data Protection Act 2023, section 8(7): personal data is erased once its purpose is served or consent is withdrawn ([text](https://prsindia.org/files/bills_acts/acts_parliament/2023/Digital_Personal_Data_Protection_Act,_2023.pdf)).

## Decision

### Storage: Stream records, the platform pulls the file into R2

The host starts a composite, 720p, spotlight-layout recording by hand through `POST /api/stream/recordings/start`, after the consent gate. Stream stores the MP4 in its own managed storage for 14 days and sends `call.recording_ready` to `/api/stream/webhooks`. For a very long call Stream emits a file every 2 hours, so a call can produce several recordings.

The webhook only upserts a `Recording` row (`READY`, `STREAM_S3`, `streamUrlExpiresAt = end_time + 14 days`). It never copies the file.

The `transfer-recordings` job (`lib/stream/recording-transfer-service.ts`) copies `READY` recordings whose Stream link is still live, soonest-expiring first, in batches of 10. It claims a row with a compare-and-set from `READY` to `TRANSFERRING` (a `TRANSFERRING` row older than 15 minutes is reset to `READY`), streams from Stream's URL into a multipart upload of 10 MB parts to Cloudflare R2 (20 GiB ceiling), verifies the stored size with `HeadObject` against the bytes streamed, and only then marks the row `AVAILABLE` with `storageType = PLATFORM` and a `storagePath`. Any failure aborts the multipart upload so no partial object remains, leaves the row `READY` and still playable from Stream's link, and is retried on the next run, up to 5 attempts. Rows that exhaust their attempts are reported to Sentry once per run, not per row.

The job runs in GitHub Actions (`cron-intra-day.yml`, every 6 hours at minute 33, 45-minute step timeout, run through `tsx`) and is also registered in `lib/cron/cleanup-registry.ts` so the HTTP twin and the back-office job runner can dispatch it.

Supabase is no longer a recording destination. Only the public preview clips and thumbnails stay in the Supabase `recordings-previews` bucket.

### Why pull, not Stream external storage

Stream can push recordings straight into a customer bucket, which would remove our copy step. We chose not to rely on it for three reasons. Stream does not document what happens when its push to an external bucket fails: there are no stated retry or fallback semantics, `call.recording_failed` carries no reason, and the GetStream/protocol discussion #371 reports problems. Twilio's analogous feature deletes the recording once its retries are exhausted. Keeping Stream's own 14-day copy as the retry source means our side can fail, repeatedly, without losing a recording. We will revisit this after a canary test of Stream external storage with deliberately bad credentials shows what it does on failure.

### Visibility: private by default

| Session type                          | Who may play                                                                                                                  |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 1:1 consultation, subscription, trial | Only that appointment's participants (consultant, payer, participants, requester). Never plan-wide, never sellable.           |
| Webinar                               | Attendees (paid or seated) of that run. `WebinarPlan.shareRecordingsWithAllAttendees` extends this to attendees of every run. |
| Class                                 | Enrolled members. `ClassPlan.lateJoinersGetPastRecordings` shares earlier sessions with late joiners.                         |

On top of those rules: the owner and accepted co-presenters (webinar and class) always have access; a platform ADMIN has full access; platform STAFF see metadata only, and each read is audited; organization roles see metadata only, as ADR 20 requires. Buyers of a published replay (a `RecordingPurchase` in `SUCCEEDED` that is not refunded) may play it. Publishing requires a durably copied (`AVAILABLE`, `PLATFORM`) recording.

Clients never receive a raw storage URL in a payload. `GET /api/stream/recordings/[recordingId]` runs the access check and returns a one-hour presigned R2 URL for `AVAILABLE` rows or Stream's URL for `READY` rows, and answers `410` once Stream's link has expired for a row that was never copied. Appointment detail and notifications link to the in-app player. `scripts/stream/ensure-call-type-grants.ts` revokes the `list-recordings` permission from the `user` and `call_member` roles so the browser SDK cannot bypass the check; operators must run it against each Stream app.

### Retention: platform-set, one schedule

The consultant storage toggle `recordingStoragePolicy` is removed from the schema; every recording is copied.

| Session type                                                                | Deleted after                                                 |
| --------------------------------------------------------------------------- | ------------------------------------------------------------- |
| 1:1 consultation                                                            | 90 days after the session                                     |
| Subscription / trial                                                        | 90 days after the subscription ends (kept while it is active) |
| Webinar                                                                     | 365 days after the session                                    |
| Class                                                                       | 365 days after the class's final session                      |
| Published replay, or any recording with a `PENDING` or `SUCCEEDED` purchase | never auto-deleted                                            |

`Organization.streamRecordingRetentionDays` is a nullable `Int` (null means the platform schedule, otherwise 7 to 3650 days after the recording) and only caps org-scoped recordings: the effective deadline is the earlier of the two. Only an OWNER can set it, through `PATCH /api/organizations/[orgId]` (`settings.ownerFields`), exemptions (published or purchased) still win, and personal recordings of org-affiliated consultants are unaffected.

The daily `expire-recordings` job (`lib/stream/recording-retention.ts`, `cron-daily.yml` at 03:00 UTC) deletes the R2 object, the preview and the thumbnail, and compare-and-sets the row to `EXPIRED`. It also expires `READY` rows whose Stream link lapsed without a copy. Org-scoped expiries write the `STREAM_RECORDING_DELETED` audit row.

### Mid-call decline in a 1:1 discards

When a participant declines during a 1:1, the `recording_ready` webhook handler and the sync path call `discardDeclinedRecording` (`lib/stream/recording-decline.ts`), which deletes the Stream recording and expires any row so no playable copy exists. This implements the [mid-session decline decision](2026-08-13-mid-session-recording-decline.md).

### Reasoning behind the schedule

Cloud meeting tools converge on time-boxed retention: Microsoft Teams defaults to a 120-day expiry ([policy](https://learn.microsoft.com/en-us/microsoftteams/manage-teams-recording-expiration-policy)), Webex keeps recordings for 360 days, and Zoom lets admins lock an auto-delete window ([article](https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0065362)). A cohort product such as Maven gives students lifetime access to a cohort's material ([help](https://help.maven.com/en/articles/9081204-student-home)), which informs the longer 365-day window for group sessions where the recording is part of what attendees bought. One-to-one sessions are the most personal and get the shortest window. Cost is small at these horizons: R2 storage is $0.015 per GB-month with free egress ([pricing](https://developers.cloudflare.com/r2/pricing/)), while Stream's HD recording costs $6 per 1,000 minutes ([pricing](https://getstream.io/video/pricing/)), so capture, not storage, is the dominant cost.

## Consequences

- A recording is not lost by a failure on our side while Stream's 14-day copy exists: the job runs every 6 hours, so a row gets several retries inside that window, bounded by 5 attempts.
- Playback of a `READY` row depends on Stream's link; after 14 days an uncopied row is `EXPIRED` and its holders get `410`.
- Webinar buyers lose access to other runs unless the host turns on `shareRecordingsWithAllAttendees`; this is a deliberate narrowing.
- Every recording row now has a deletion date, except exempted replays. Erasure is a daily job, so a failed run is a compliance gap and must be treated as one.
- Consultants lose the storage toggle, the manual Transfer button and the expiry-warning emails; there is nothing to choose and nothing to warn about because the copy is automatic.
- Operators need R2 credentials in Netlify (all contexts) and GitHub Actions secrets: `R2_S3_ENDPOINT`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`.
- Org owners can shorten retention for org-scoped sessions but cannot extend it past the platform schedule.

## Alternatives considered

- **Stream external storage (push to our bucket).** Removes the copy step but has undocumented failure behaviour and no fallback copy; a bad credential could lose recordings silently. Deferred until a bad-credentials canary proves the behaviour.
- **Cloudflare Stream for hosting.** Offers adaptive-bitrate playback but costs roughly 20 times R2 for storage. It is a candidate only for a paid replay library later, where adaptive bitrate earns its price.
- **Consultant-selected storage tier.** The `STREAM_ONLY` and `PERMANENT` toggle let a consultant lose a recording by default, made one upgrade gate part of the pipeline, and left personal recordings without any deletion date. Removed.
- **Flat 90 days for everything.** Simple, but it destroys group-session recordings that attendees paid for and that replay buyers rely on.
- **Lifetime retention for group sessions.** Matches cohort products, but conflicts with storage limitation and leaves an unbounded storage liability for content nobody watches.
- **Organization full override of retention.** Would let an org keep personal-affiliated or longer-than-platform recordings. Rejected: the org cap only shortens, and ADR 20 limits what organizations see of member sessions.

## Deprecated & Superseded Approaches

- Webhook-triggered transfer inside Netlify `after()`: a 26-second function limit against files near 1 GB.
- Supabase Storage as the recording destination: the Free plan caps objects at 50 MB.
- The per-plan `STREAM_ONLY` / `PERMANENT` storage policy, the manual Transfer button and its `UPGRADE_REQUIRED` refusal, and the 500 MB transfer cap, and `RecordingStoragePolicy` with its plan columns.
- Consultant expiry-warning emails.
- The `transfer-expiring-recordings`, `mark-expired-recordings` and `cleanup-old-stream-recordings` jobs, replaced by `transfer-recordings` and `expire-recordings`.
- `Class.recordingUrls`.
- The env names `R2_ACCOUNT_ID`, `R2_RECORDINGS_BUCKET` and `CLOUDFLARE_R2_*`.
- Plan-wide webinar recording access by default.
