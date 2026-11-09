# Recordings Marketplace — Curated Replay Library

This doc is the source of truth for the sellable-recordings design and its invariants. How recordings are captured, copied, stored and deleted is in [Stream Recording & Webhooks](./13-recording-webhooks.md); the governing decision is [ADR 2026-10-09](../decisions/2026-10-09-recording-storage-retention-visibility.md).

> **Status (2026-10-26): publishing is closed.** At launch, recordings are included with the booking and nothing is sold separately. `POST /api/stream/recordings/[recordingId]/publish` has been removed, so no recording can become `PUBLISHED`, `/explore/products` has no Replays tab, and the purchase route answers `404 NOT_LISTED` for every recording. Unpublish (`DELETE`) remains. Replays return as their own product, a `ReplayListing` that groups a webinar run's or a class batch's recordings (#2412). The rules below are the requirements that design must keep.

## What it is

An opt-in, consultant-curated marketplace for **webinar and class replays only**:

- A published `Recording` row (`listingStatus = PUBLISHED`) carries a price, copy, tags, slug and preview clip. Publishing is closed (see the status note above); the `RecordingManageSheet` drawer only offers unpublish.
- Buyers purchase standalone replays with no booking required, from the replay add-on on the webinar or class page once `ReplayListing` exists. Playback lands in their dashboard resources.

Replay sales go live once the copy pipeline has been proven on real recordings. Until a recording has been copied, it cannot be published.

## Non-negotiable invariants

1. **Durably-ours listings only.** A published recording must satisfy `isDurablyOurs()`: `status = AVAILABLE` and `storageType = PLATFORM`, meaning the transfer job has copied and size-verified it in R2. Stream's copy dies 14 days after the call and is not revocable, so a recording that has not been copied must never be sold. The rule is defined once in `lib/stream/recording-storage.ts` (`isDurablyOurs` and `durablyOursWhere`). It is enforced by `publicRecordingWhere()` (`lib/data/recordings-explore.ts`) and again when a purchase settles (`lib/payments/webhooks/recording-purchase.ts`), so a recording that stops qualifying after it is listed cannot be sold.
2. **Webinar and class plans only.** Consultation, subscription and trial recordings cannot be listed. One-to-one recordings are private to that appointment's participants and are never sellable. `recordingEnabled` exists on every plan type, including consultation plans, so a host can record a 1:1; it is visibility, not recordability, that keeps a 1:1 off the marketplace.
3. **Consent attestation at publish.** `consentAttestedAt` and `consentAttestedById` are written in the same update as `PUBLISHED`. No attestation, no listing.
4. **Metadata-only public reads.** `/api/explore/recordings` (a public prefix in middleware) returns listing metadata only. Playback URLs come exclusively from the authenticated `GET /api/stream/recordings/[recordingId]` route, after the visibility check described in [Visibility](./13-recording-webhooks.md#visibility): owner, accepted co-presenter, attendee or enrollee per plan rules, platform ADMIN, or a buyer holding a `SUCCEEDED`, non-refunded `RecordingPurchase`.
5. **Sold replays are never auto-deleted.** A published replay, and any recording with a `PENDING` or `SUCCEEDED` purchase, is exempt from the platform retention schedule, and from an organization's cap. Deleting a recording that has buyers is refused.

When publishing returns, it must commit with a conditional update requiring the recording to remain `AVAILABLE` on `PLATFORM`, with the same storage pointer, listing status and preview fields that were validated. If retention, removal, unpublish or preview editing changes those fields first, the publish request must return `409 RECORDING_CHANGED` without invalidating the public cache. It must also require consent attestation before any write, refuse a preview clip without a text transcript, and map a concurrent slug clash (`P2002`) to `SLUG_TAKEN`. If publication wins first, retention's write predicate excludes the published row.

The storage/listing database check requires a published row to retain its path, price and consent, but permits `EXPIRED` with `PUBLISHED` while the path remains. The conditional publish write is what closes that expiry race; the database check alone does not. This guard does not resolve erasure's separate copy-publication and asset-cleanup ownership window, which remains a recovery activation prerequisite.

## Purchase flow

```
POST /api/recordings/[id]/purchase  -> Razorpay order, notes.type=recording_purchase
                                     -> RecordingPurchase row (PENDING, gatewayOrderId unique)
payment.captured / order.paid        -> handleRecordingPurchaseSuccess
                                        (PENDING -> SUCCEEDED, with Payment, earnings and BOOKING journal in one transaction)
payment.failed                       -> handleRecordingPurchaseFailure (only from PENDING)
```

A replay purchase settles as a real `Payment` row (`appointmentId = null`) with its earnings and ledger journal, written together with the `RecordingPurchase` transition by `lib/payments/webhooks/recording-purchase.ts`. A capture that cannot fulfil a purchase (the replay is no longer purchasable, the buyer already holds it, a second payment on a settled order, or a purchase row deleted with its recording) is recorded as a `SUCCEEDED` `Payment` carrying the auto-refund marker and refunded after commit; `retry-auto-refunds` re-drives it.

Refunds of a fulfilled purchase are support-led: support marks the row `REFUNDED`, which removes the buyer's entitlement. A buyer who was refunded and buys again gets a new `RecordingPurchase` row.

## Storage layout & playback continuity

| Asset                      | Location                                                                                | Visibility & TTL                                                                                            |
| -------------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Full recording             | Cloudflare R2 (`R2_BUCKET`), attempt-scoped key `recordings/{id}/attempt-{attempt}.mp4` | Private; duration-scaled presigned URL (`max(4h, min(24h, 1h + 2 × duration))`) via `playbackUrlTtlSeconds` |
| Preview clip and thumbnail | Supabase bucket `recordings-previews`                                                   | **Public**, immutable cache                                                                                 |

- **Attempt-isolated storage keys (`attempt-{attempt}.mp4`):** Each transfer retry writes to `recordings/{recordingId}/attempt-{attempt}.mp4` (`MAX_TRANSFER_ATTEMPTS = 12`, exponential backoff `[15m, 1h, 6h, 24h]`), guaranteeing a stalled worker's late failure cleanup (`deleteR2Object`) can never delete another winning attempt's MP4. Superseded prior attempts (`attempt-1..{attempt-1}.mp4`) are removed asynchronously after `status = AVAILABLE` commits.
- **Database CHECK enforcement (`Recording_storage_and_publish_check`):** Enforced in `prisma/sql/check-constraints.sql` (`NOT VALID` + `VALIDATE CONSTRAINT`) so non-expired `PLATFORM` rows cannot persist without `storagePath` (an `EXPIRED` row may have none), `AVAILABLE` rows require `PLATFORM`, and `PUBLISHED` rows require `PLATFORM`, `storagePath`, `listPricePaise > 0`, and explicit consultant consent attestation.
- **Seamless playback recovery (`RecordingPlayerModal`):** If a long session outlives its presigned URL or receives a refreshed `recording.playbackUrl` prop, `RecordingPlayerModal` preserves `savedTimeRef.current` across URL swaps (`[open, recordingId]` reset boundary), fetches a fresh presigned URL in the background without unmounting `<video>`, and restores `video.currentTime` automatically on `loadedmetadata`.

## Caching

`/explore/products` no longer lists replays; when they return they are listed from the webinar or class page. Unpublish (and publish, when it returns) and the unpublish step of a host's erasure (after the scrub transaction commits) call `purgeRecordingSurfaces()` (`lib/data/public-cache.ts`), which clears the `recordings` tag and `/explore/products` (and the affected detail path) at the write site, so listing cards never outlive an unpublish by more than one request. The public list API also sends a short CDN `Cache-Control` (`s-maxage=60, stale-while-revalidate=300`).

## Open items

- Preview-clip accessibility: WebVTT timed caption tracks alongside `previewClipUrl` for speech clips (plain-text `previewTranscript` is currently required and rendered).
- Automated partial refunds for fulfilled `RecordingPurchase` rows through the refund pipeline.

## Deploy notes

1. Ensure the branch is up to date with `dev` and verify additive delta read-only via `npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script`.
2. Apply sidecar constraints safely with `NOT VALID` followed by `VALIDATE CONSTRAINT` (`npm run db:sidecars`) so `Recording` never holds a prolonged `ACCESS EXCLUSIVE` scan lock.

## Deprecated & Superseded Approaches

- **Per-recording publishing (removed 2026-10-26)**: `POST .../publish` listed one `Recording` segment at a time, so a restarted webinar or a multi-session class could only be sold piece by piece. It was removed along with `resolvePreviewTranscript` and its tests, and is superseded by the `ReplayListing` design (#2412).

- **The Replays tab of `/explore/products` (removed 2026-11-09)**: it listed published recordings through `listPublicReplayCards()` and a `?tab=` parameter, and only ever showed an empty state once publishing closed. The tab, its parser and the card cache are deleted; replays return as an add-on on the webinar or class page under the `ReplayListing` design.
- **Fixed 1-hour presigned playback TTL & shared `composite.mp4` R2 keys**: Fixed 1-hour presigned URLs expired mid-watch on multi-hour webinars, and static `composite.mp4` keys allowed stale transfer retries to delete a concurrent winner's published MP4. Superseded by `playbackUrlTtlSeconds` (`>= 4h`), `savedTimeRef` playback position preservation, and attempt-scoped `recordings/{id}/attempt-{attempt}.mp4` keys.
- **`storageType = SUPABASE` listings & manual transfer route**: Replaced by `RecordingStorageType.PLATFORM` (Cloudflare R2) and automated background transfers via `transfer-recordings` (`lib/stream/recording-transfer-service.ts`).
- **Settling replay purchases outside `Payment`**: Replay purchases now settle atomically as `Payment` rows with earnings and `BOOKING` ledger journals (`lib/payments/webhooks/recording-purchase.ts`).
