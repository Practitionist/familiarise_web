# Recordings Marketplace — Curated Replay Library

This doc is the source of truth for the sellable-recordings design and its invariants. How recordings are captured, copied, stored and deleted is in [Stream Recording & Webhooks](./13-recording-webhooks.md); the governing decision is [ADR 2026-10-09](../decisions/2026-10-09-recording-storage-retention-visibility.md).

## What it is

An opt-in, consultant-curated marketplace for **webinar and class replays only**:

- A consultant publishes individual `Recording` rows (`listingStatus = PUBLISHED`) with a price, copy, tags, slug and preview clip, from the `RecordingManageSheet` drawer on the dashboard recordings page.
- Buyers purchase standalone replays from `/explore/recordings` with no booking required. Playback lands in their dashboard resources.

Replay sales go live once the copy pipeline has been proven on real recordings. Until a recording has been copied, it cannot be published.

## Non-negotiable invariants

1. **Durably-ours listings only.** A published recording must satisfy `isDurablyOurs()`: `status = AVAILABLE` and `storageType = PLATFORM`, meaning the transfer job has copied and size-verified it in R2. Stream's copy dies 14 days after the call and is not revocable, so a recording that has not been copied must never be sold. The rule is defined once in `lib/stream/recording-storage.ts` (`isDurablyOurs` and `durablyOursWhere`). It is enforced by `publicRecordingWhere()` (`lib/data/recordings-explore.ts`), again in the publish route, and again when a purchase settles (`lib/payments/webhooks/recording-purchase.ts`), so a recording that stops qualifying after it is listed cannot be sold.
2. **Webinar and class plans only.** Consultation, subscription and trial recordings cannot be listed. One-to-one recordings are private to that appointment's participants and are never sellable. `recordingEnabled` exists on every plan type, including consultation plans, so a host can record a 1:1; it is visibility, not recordability, that keeps a 1:1 off the marketplace.
3. **Consent attestation at publish.** `consentAttestedAt` and `consentAttestedById` are written in the same update as `PUBLISHED`. No attestation, no listing.
4. **Metadata-only public reads.** `/api/explore/recordings` (a public prefix in middleware) returns listing metadata only. Playback URLs come exclusively from the authenticated `GET /api/stream/recordings/[recordingId]` route, after the visibility check described in [Visibility](./13-recording-webhooks.md#visibility): owner, accepted co-presenter, attendee or enrollee per plan rules, platform ADMIN, or a buyer holding a `SUCCEEDED`, non-refunded `RecordingPurchase`.
5. **Sold replays are never auto-deleted.** A published replay, and any recording with a `PENDING` or `SUCCEEDED` purchase, is exempt from the platform retention schedule, and from an organization's cap. Deleting a recording that has buyers is refused.

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

## Storage layout

| Asset                      | Location                                                    | Visibility                                              |
| -------------------------- | ----------------------------------------------------------- | ------------------------------------------------------- |
| Full recording             | Cloudflare R2 (`R2_BUCKET`), key in `Recording.storagePath` | Private; one-hour presigned URL from the playback route |
| Preview clip and thumbnail | Supabase bucket `recordings-previews`                       | **Public**, immutable cache                             |

Preview assets are marketing material for ISR-cached anonymous explore cards; signed URLs would expire under cache. Deterministic paths (`<recordingId>/...`) keep re-uploads orphan-free. The `expire-recordings` job deletes the preview and thumbnail together with the R2 object when a recording expires.

## Caching

`/explore/recordings` uses ISR (`revalidate = 300`). Publish and unpublish call `revalidatePath("/explore/recordings")` (and the affected detail path) at the write site, so listing cards never outlive an unpublish by more than one request. The public list API also sends a short CDN `Cache-Control` (`s-maxage=60, stale-while-revalidate=300`).

## Open items

- Preview-clip accessibility: a WebVTT caption track or transcript alongside `previewClipUrl` for clips that contain speech. This needs a transcript asset pipeline; the detail page currently renders the clip without a track.
- A registration-time redistribution-consent checkbox on the attendee join, feeding the publish attestation instead of relying on it alone.
- Automated refunds for fulfilled `RecordingPurchase` rows through the refund family.

## Deploy notes

### Schema before build, not after merge

The usual rule is "merge the PR, then `npm run db:push` from `dev`". That rule is wrong for any PR that adds columns **and** prerenders a page that reads them. `/explore/recordings` is ISR-prerendered during `next build`, so the build reads the shared database; push after merging and the build fails before the merge can happen with `The column Recording.<column> does not exist in the current database`.

The order for such a PR:

1. Bring the branch fully up to date with `dev` (`git merge origin/dev`), so its schema is a strict superset. A push from a branch reconciles the database to _that branch's_ schema, and anything missing from it is dropped.
2. Verify the delta is additive with `npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script` and confirm there is no `DROP TABLE`, `DROP COLUMN` or `SET NOT NULL`.
3. `npx prisma db push` from the branch, then `npm run db:sidecars`.
4. Re-run CI and the deploy preview, then merge.

On step 3, `db push` warns that adding a unique constraint "will fail if there are existing duplicate values". For a new nullable column that warning is a false positive: every existing row gets NULL and Postgres unique indexes permit unlimited NULLs. Confirm the column does not yet exist before accepting data loss.

A `db push` from any checkout whose `schema.prisma` lacks these columns (plain `dev` before the branch lands) silently drops them, and the listing then fails prerender with Prisma `P2022`. If a preview fails with that error, re-apply the additive SQL rather than debugging the app.

## Deprecated & Superseded Approaches

- **`storageType = SUPABASE` listings**: the enum value is now `PLATFORM`, a vendor-neutral "our bucket", and full recordings live in R2. Supabase holds only preview assets.
- **Manual transfer as a premium feature**: the transfer route returned `403 UPGRADE_REQUIRED` for `STREAM_ONLY` plans. There is no storage policy and no transfer route; every recording is copied by the `transfer-recordings` job.
- **Replay purchase as "not a Payment row"**: replay purchases were once settled off `gatewayOrderId` alone. They now settle as a `Payment` with earnings and a journal.
- **Publish UI missing**: the consultant publish flow lives in `RecordingManageSheet`.
- **Plan-wide webinar access to the recording**: replaced by per-run access with an opt-in share setting.
