# P0 — Recording Storage, Transfer & Massive Scale Infrastructure

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

**Severity: P0 (infrastructure / data-loss risk at growth)**  
**Related:** `recordings-webhooks.md`, `docs/stream/13-recording-webhooks.md`, `docs/stream/14-pricing-and-cost-model.md`  
**Code:** `lib/stream/recording-transfer-service.ts`, `jobs/stream/transfer-expiring-recordings.ts`, `.github/workflows/transfer-expiring-recordings.yml`

## Context

Familiarise uses a **two-stage recording model**:

1. Stream records the call and stores the file on **Stream-managed S3** (default). Stream retains recordings for **two weeks**, then deletes them. Signed download URLs expire with that window. Stream does **not** charge extra for this temporary storage; recording itself is billed as a **recording call-minute add-on** (HD ≈ **$6 / 1,000 call-minutes** per our April 2026 calculator notes).
2. For plans with `recordingStoragePolicy = PERMANENT`, the file is transferred into our own private bucket: kicked off **immediately** on `call.recording_ready`, with a **GitHub Actions cron** (`58 */6 * * *`, concurrency 3) as the backstop sweeper, before the URL dies. Org retention later tombstones DB rows at ~**90 days** by default (`streamRecordingRetentionDays`) and now deletes the object too.

_(Corrected 2026-09-30: the enum value is `PERMANENT`, renamed from `SUPABASE_PERMANENT` by `prisma/sql/one-off/2026-08-30-rename-recording-storage-vendor.sql`. The batch-size, in-memory and dead-code claims below were all true on 2026-07-12 and are all superseded — see the corrected table.)_

This is the right _product_ idea (temp capture → permanent object store). It is **not** an infrastructure design that survives medium-to-massive concurrent webinars/classes.

Stream also offers a better vendor path we are **not** using yet: configure **external storage** (S3 / GCS / Azure) on the call type so Stream **writes recordings directly into our bucket** — no download-reupload hop, no 14-day race. See [Stream external storage docs](https://getstream.io/video/docs/api/recording/storage/).

## Triage verdict (2026-07-12)

Triaged 2026-07-12 against real code (3 verifier agents cross-checked every claim); fix wave PRs #981–#994 shipped. The infrastructure claims here are almost all accurate — the Phase-0 remediation shipped, but the deeper rearchitecture was a deliberate design decline. Claims map as follows:

| Claim (short)                                                                                  | Verdict                                                                                                        |
| ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Phase-0: enqueue-on-`recording_ready`, wire dead `queueRecordingTransfer`                      | ✅ FIXED-BY #983                                                                                               |
| Phase-0: streaming/multipart upload (no full in-memory `blob()`)                               | ✅ FIXED-BY #983                                                                                               |
| Phase-0: org retention deletes the Supabase object, not only DB status                         | ✅ FIXED-BY #983 (orphan-object fix)                                                                           |
| Phase-0: bounded concurrent transfers + near-expiry backlog alert                              | ✅ FIXED-BY #983                                                                                               |
| Phase-0: doc drift (3 vs 5 day window), cap infinite retries                                   | ✅ FIXED-BY #983                                                                                               |
| `>500MB` hard-reject cap                                                                       | ✅ FIXED-BY #983 (streaming upload revisits the cap)                                                           |
| `createMeeting()` dead code                                                                    | ✅ FIXED-BY #983 (deleted)                                                                                     |
| `streamUrlExpiresAt = recordedAt + 14d`                                                        | ❌ OVERSTATED — code uses `now() + 14d` (immaterial to the argument)                                           |
| Phase-1/2: Stream external S3, durable workflows (Temporal/Inngest), microservice split, Kafka | 🎯 DECLINED — Supabase stays the permanent store; monolith + cron backstop; no Temporal/Kafka/microservice now |

## What we have today (concrete)

> **⚠️ This table described the system BEFORE #983 and was corrected on
> 2026-09-30.** The old values are kept struck through so the delta is legible.
> Every "fixed by #983" row in the verdict table above is visible here.

| Setting                                                  | Value                                                                                                                                                                                                                                                                                                                        |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stream S3 retention                                      | **14 days** (vendor)                                                                                                                                                                                                                                                                                                         |
| Familiarise `streamUrlExpiresAt`                         | `now() + 14 days` (this dossier's "OVERSTATED" note was right: it is not `recordedAt + 14d`)                                                                                                                                                                                                                                 |
| Backlog alert threshold                                  | **72 hours** before expiry (`countAtRiskPermanentRecordings(72)`) — the job pages on a non-zero count                                                                                                                                                                                                                        |
| Cron cadence                                             | `58 */6 * * *` → **4 runs/day**                                                                                                                                                                                                                                                                                              |
| ~~Batch size: 10 per run, sequential~~                   | **Concurrency 3**, chunked: `for (let i = 0; i < n; i += CONCURRENCY)` (`recording-transfer-service.ts:872-874`)                                                                                                                                                                                                             |
| GH Actions timeout                                       | **15 minutes**                                                                                                                                                                                                                                                                                                               |
| ~~Max file size: 500 MB hard reject~~                    | **`RECORDING_MAX_OBJECT_BYTES`, default 5 GiB**, overridable per environment. Enforced by a byte-counting `TransformStream` (`capStream`), so bytes are counted **as they stream** rather than after a full in-memory read. **Note:** inert on the Supabase free plan, which clamps every object to 50 MB regardless (#1314) |
| ~~Transfer method: full `fetch` + `blob()` into memory~~ | **Streaming upload.** No full-body buffer; a ceiling breach is tagged `RECORDING_OBJECT_CEILING` so the catch can tell it from a storage fault                                                                                                                                                                               |
| Failure policy                                           | revert to `READY`, retry until the URL is near death; alert after **3** attempts (`TRANSFER_FAILURE_ALERT_THRESHOLD = 3`)                                                                                                                                                                                                    |
| Immediate transfer on `recording_ready`                  | **Yes.** `lib/stream/recording-handlers.ts:485-495` calls `queueRecordingTransfer` on ready, gated on the appointment's resolved storage policy being `PERMANENT`                                                                                                                                                            |
| ~~`queueRecordingTransfer()` — dead code, never called~~ | **Live.** Called from the `recording_ready` handler, and the cron remains the backstop sweeper                                                                                                                                                                                                                               |

The `recording_ready` handler's policy gate is itself a fix worth naming: before
it, the row was flipped to `EXPIRED` by `markExpiredRecordings` with **no policy
filter at all**, so a customer who had paid for permanent storage silently lost
it while the console reported the row as fine.
| STREAM_ONLY plans | never transferred; Novu warning only |

### Throughput reality check

Assume a busy day: 2,000 recorded webinar/class sessions need permanent storage (not fantasy at “hundreds of thousands of customers” with concurrent cohorts).

_(The arithmetic below is the pre-#983 pipeline and is kept as the record of
why Phase 0 was needed. Two of its three inputs no longer hold: the ceiling is
now 5 GiB rather than 500 MB, and the object is streamed rather than buffered, so
the OOM failure mode is gone. The throughput ceiling is not gone — see the
"still open" note at the end of this section.)_

- ~~Current pipeline: ~40 transfers/day~~ → backlog ≈ **50 days** of work for one busy day.
- Stream deletes at day 14 → **most files die before transfer**.
- ~~One ~400–500 MB HD webinar can dominate a 15-minute runner; OOM risk is real because the whole object is buffered in memory.~~ **No longer true** — streaming upload, 5 GiB ceiling.

Cron + GH Actions is fine for **design-partner volume**. It remains a
**data-loss machine at marketplace scale**, for a different reason than it was
in July 2026: not per-file memory, but total throughput. The cron still moves
roughly 40 files/day and the runner is still capped at 15 minutes. The mitigation
that exists is the **72-hour backlog alert**, which pages before the bytes lapse
rather than discovering the loss afterwards.

**Still open after #983:** throughput. Concurrency is 3 inside one 15-minute
runner, so raising it means a real worker host, or Stream external storage so
Stream writes into the bucket directly and there is no transfer at all.

## Pricing (what to model)

### Stream (capture cost — always paid if recording is on)

- Participant video minutes (HD default) + **recording add-on** (~$6/1k recording call-minutes HD).
- Default Stream S3 storage for 14 days: **no extra storage fee** (per Stream docs).
- Long calls split into **≤2 hour** recording files — one session can produce multiple objects.

Rough order-of-magnitude (illustrative, not a quote):

| Scenario                       | Recording call-min / month | Recording add-on ≈ |
| ------------------------------ | -------------------------- | ------------------ |
| 500 × 60 min recorded sessions | 30,000                     | ~$180              |
| 5,000 × 60 min                 | 300,000                    | ~$1,800            |
| 50,000 × 60 min                | 3,000,000                  | ~$18,000           |

Plus participant-minute video cost (often larger than recording itself). See `docs/stream/14-pricing-and-cost-model.md`.

### Permanent storage (our bill after transfer or external write)

Supabase Storage (Pro-ish list prices, 2026):

- Storage size overage ≈ **$0.0213 / GB-month** after plan quota (Pro includes ~100 GB).
- Egress: uncached ~**$0.09 / GB**, cached CDN ~**$0.03 / GB** after quota.

If average permanent recording is **250 MB**:

| Retained recordings | Storage ≈ | Storage $/mo (overage-ish) |
| ------------------- | --------- | -------------------------- |
| 10,000              | 2.5 TB    | ~$53                       |
| 100,000             | 25 TB     | ~$530                      |
| 1,000,000           | 250 TB    | ~$5,300                    |

Egress dominates if many users rewatch (or if our transfer pipeline downloads from Stream _and_ uploads — double network today). **External storage (Stream → our S3 directly)** removes the Familiarise download hop and much of the failure surface.

**Hidden cost:** GH Actions minutes, eng on-call for transfer failures, support for “recording disappeared,” and dispute evidence loss when STREAM_ONLY or backlog misses the 14-day window.

## Complexity we have _not_ fully tackled

1. **Deadline-driven work** — every permanent recording is a workflow with a hard vendor TTL, not a best-effort nightly job.
2. **Concurrency** — hundreds of webinars ending in the same hour → thundering herd of multi-hundred-MB transfers.
3. ~~**Worker memory** — in-memory `blob()` cannot be the transfer unit at scale.~~ **RESOLVED by #983** — the transfer is a streaming upload with a byte-counting ceiling, so there is no full-body buffer.
4. **Idempotency** — partial upload + crash must not corrupt or double-bill storage; Supabase `upsert` helps but status CAS must be perfect.
5. **Multi-file sessions** — Stream uploads a new file every 2 hours of recording; one `Meeting` row may map to N `Recording` rows.
6. **Policy mix** — `STREAM_ONLY` vs `PERMANENT` vs org retention vs DPDP erasure must compose.
7. **Orphan objects** — DB tombstone without bucket delete → silent storage bill growth.
8. **Region / compliance** — where bytes live (Stream region vs Supabase vs future India residency requirements).
9. **Observability** — backlog depth, age-to-expiry histogram, bytes in flight, failure rate — not first-class today.
10. **Product honesty** — users on STREAM_ONLY think “recording” means forever.

## Are cron jobs enough?

| Scale                                                       | Verdict                                                                                                   |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Design partners / low hundreds of permanent recordings/week | **Yes**, with monitoring and a smaller transfer window (or immediate enqueue).                            |
| Thousands of permanent recordings/day                       | **No** — 40/day ceiling and 15-min runners will lose data.                                                |
| Hundreds of thousands of concurrent events                  | **Definitely no** — need durable orchestration + horizontal workers + preferably Stream external storage. |

Cron is a **scheduler**, not a **workflow engine**. It cannot resume mid-download after OOM, cannot fairly share capacity across tenants, and cannot express “must finish 48h before Stream deletes.”

## Do we need Temporal / Kafka / RabbitMQ / microservices?

### Short answer

- **Do not** split into a recording microservice yet.
- **Do** stop using “poll near expiry + sequential cron” as the permanent architecture.
- **Prefer Stream external storage (S3)** as the primary durability strategy, with Familiarise owning metadata + lifecycle.
- **Add a durable job runner** (Temporal or equivalent) when transfer/transcode/lifecycle work outgrows cron — not Kafka-as-workflow.

### Option comparison

| Approach                                    | Role                        | Fit for recordings?                                                                                             |
| ------------------------------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------- |
| **GitHub Actions cron (current)**           | Periodic batch              | OK for tiny volume; fails hard deadlines at scale                                                               |
| **Redis/BullMQ / RabbitMQ**                 | Task queue                  | Good for fan-out of short jobs; you still invent retries, visibility, “resume after 400MB download crash”       |
| **Kafka**                                   | Event log / fan-out         | Great for `recording_ready` ingestion at huge event rates; **bad** as the state machine for long transfers      |
| **Temporal (or Inngest/Trigger.dev class)** | Durable workflow            | Best fit for multi-step transfer/lifecycle with retries, heartbeats, timers (“alert if not permanent by T-72h”) |
| **Stream external S3/GCS**                  | Vendor writes to our bucket | **Best leverage** — removes download-reupload for the happy path                                                |
| **Full microservice split**                 | Separate deployable         | Premature until worker pool + queue exist; adds ops tax without solving TTL                                     |

Industry pattern for video pipelines (e.g. Temporal + DB as system of record): **Temporal owns execution, Postgres owns business state** (`Recording` row). Do **not** put multi-GB payloads in the workflow history — pass object keys only; stream bytes on workers with heartbeats.

## Recommended strategy (medium → massive)

### Phase 0 — Stop the bleeding (this quarter, still monolith)

1. Treat permanent retention as a **SLA**: “available in our storage within N hours of `recording_ready`,” not “sometime in the last 5 days before Stream deletes it.”
2. ~~On `call.recording_ready` for `SUPABASE_PERMANENT`, enqueue immediately (wire the dead `queueRecordingTransfer`…).~~ **DONE by #983** — `queueRecordingTransfer` is called from the `recording_ready` handler, gated on the resolved policy, and the cron remains a backstop sweeper.
3. Raise effective throughput: parallel workers (even 5–10 concurrent transfers on a real worker host), streaming upload (no full `blob()`), multipart for large objects.
4. Alert on backlog: count of `READY` permanent recordings with `streamUrlExpiresAt - now < 72h`.
5. Fix org retention to **delete or lifecycle-expire Supabase objects**, not only DB status.
6. Fix doc drift (3 vs 5 day window). Cap or page infinite retries once URL is near death.

### Phase 1 — Medium scale (thousands of permanent recordings / day)

**Recommendation: Stream external storage → our S3 (or GCS), Familiarise metadata stays in Postgres.**

Why this wins:

- Stream uploads **directly** to our bucket when the recording is ready (same region options, up to 10 storage configs).
- Eliminates most transfer failures, GH Actions OOM, and the 14-day race for permanent plans.
- Familiarise webhook still creates `Recording` rows pointing at **our** object key; playback via signed URLs from our store.
- Supabase can remain the app DB + optional CDN front, or we standardize on S3 and serve via CloudFront — pick one object store as source of truth.

**Add Temporal (or Inngest if we want lighter ops)** only for:

- Verify object exists / size / checksum after Stream write
- Transcode / thumbnail / virus scan (if product needs)
- Retention & DPDP erasure workflows
- Backfill / repair when webhook missed

Keep the Next.js monolith; run **workers** as a second process/service in the same repo (not a new bounded context yet).

### Phase 2 — Massive scale (tens–hundreds of thousands concurrent recorded sessions)

1. **Horizontal worker pools** sized by CPU/network, separate task queues for “verify,” “transcode,” “delete.”
2. Optional **Kafka/Pulsar** only if webhook ingress or analytics fan-out needs multi-subscriber streaming — not required to start Temporal.
3. Per-tenant fairness (org quotas) so one enterprise cohort cannot starve the transfer/verify queue.
4. Tiered storage (hot S3 ↔ Glacier/Cold) matching `streamRecordingRetentionDays` and dispute holds.
5. Cost controls: default STREAM_ONLY or short retention; permanent storage as paid SKU; recording quality caps for large classes.
6. Still **no** need for a forest of microservices — a **recording worker fleet + orchestration + object store** is enough. Split a service when team/ownership or scaling isolation demands it, not before.

## Unhappy paths & user psychology

- Consultant records a flagship webinar; cron backlog + Stream 14-day delete → “Familiarise lost my recording” → chargeback + churn.
- Enterprise buyer requires 1-year retention in contract; our tombstone at 90 days hides the file while we still pay for orphaned bytes — or worse, we promised permanent and delivered STREAM_ONLY.
- Support cannot explain why some plans keep recordings and others vanish after two weeks.
- Dispute evidence needed on day 20; STREAM_ONLY recording already gone.

## Questions (handled?)

1. **Primary durability strategy for permanent recordings?**
   - A) Keep Stream S3 + Familiarise pull-transfer (current)
   - B) Stream external storage writing directly to our S3/GCS
   - C) Record client-side / third-party recorder

**Recommendation: B.** Stream’s supported external storage removes the brittle download-reupload race and is the only path that survives concurrent webinar scale without inventing a video CDN team.

- Not A: Current ~40 transfers/day and in-memory blobs will lose data under load.
- Not C: Client-side recording is unsupported by Stream’s model and creates worse device/consent chaos.

> 🎯 Locked: Supabase stays the permanent store — the pull-transfer path (option A) is retained with the Phase-0 hardening; Stream external S3 is declined for now.

2. **Orchestration for transfer/verify/retention workflows?**
   - A) GitHub Actions cron forever
   - B) Durable workflows (Temporal / Inngest) + cron as sweeper only
   - C) Kafka consumers as the state machine

**Recommendation: B.** Durable workflows match deadline-driven media work (retries, heartbeats, timers); keep cron as a safety net that starts repair workflows.

- Not A: Cron cannot resume mid-transfer or guarantee completion before Stream TTL.
- Not C: Kafka is transport; using it as a workflow store recreates Temporal poorly.

> 🎯 Locked: Monolith + GH Actions cron (as backstop sweeper) stays; no Temporal/Inngest or Kafka workflow engine is adopted now.

3. **When do we introduce a separate recording microservice?**
   - A) Now, as part of this fix
   - B) Only after worker pool + external storage exist and ownership splits
   - C) Never — forever in Next.js request handlers

**Recommendation: B.** Stay monolith-plus-workers until scale and team boundaries justify a split; premature microservices add deploy/ops cost without fixing the TTL problem.

- Not A: Splitting now delays the real fix (external storage + enqueue-on-ready).
- Not C: Long media work must not live in serverless request timeouts forever.

> 🎯 Locked: No separate recording microservice — stay monolith-plus-cron.

4. **Default product policy for new plans?**
   - A) STREAM_ONLY (14-day) default; permanent as paid add-on
   - B) `PERMANENT` / our-S3 for all recorded events
   - C) No recording unless enterprise contract

**Recommendation: A.** Make permanent storage an explicit paid SKU so Stream minutes + object-store GB stay economically tethered to revenue.

- Not B: Free permanent retention at marketplace scale becomes an unbounded storage liability.
- Not C: Too harsh for SMB consultants who expect basic temporary replay.

5. **Object store of record?**
   - A) Supabase Storage long-term
   - B) AWS S3 (Stream external storage native) + signed playback
   - C) Dual-write Supabase and S3

**Recommendation: B.** Stream’s first-class external storage is S3/GCS/Azure; aligning on S3 minimizes glue and lets us use lifecycle rules / Glacier. Supabase remains DB/auth.

- Not A: Pull-transfer into Supabase keeps the two-hop design and GH Actions coupling.
- Not C: Dual-write doubles cost and consistency bugs.

> 🎯 Locked: Supabase Storage remains the object store of record (option A); recording rows expire at `now() + 14d`.

## High concurrency / multi-device

Hundreds of classes ending on the hour must not serialize through one GH Actions job. Enqueue per `recording_ready` (and per 2-hour chunk file). Workers claim with CAS on `Recording.status`. Multi-device playback only needs signed URLs from durable storage — the hard problem is **write path scale**, not read path (CDN).

## Suggested directions (ordered)

1. **Declare this a P0 infra risk** in roadmap; measure current permanent-recording volume and backlog.
2. **Spike Stream external S3** on staging call type; webhook → metadata only.
3. **Immediate enqueue** for any remaining pull-transfers; cron = sweeper.
4. **Streaming multipart upload** + size >500MB strategy (chunked files from Stream already help).
5. **Adopt Temporal/Inngest** when verify/transcode/retention workflows exceed cron comfort (likely with Phase 1).
6. **Do not** introduce Kafka or a recording microservice until Phase 2 pressures are real.
7. Price **permanent retention** as a SKU; align privacy policy with org retention + hard deletes.

## Bottom line

We _thought_ about the happy path (Stream temp → Supabase permanent via cron). We have **not** built infrastructure for concurrent, deadline-driven media at marketplace scale. Cron jobs are **not enough** past early traction. The best strategy is **Stream → our object store directly**, **Postgres as metadata source of truth**, **durable workflows for lifecycle**, and **workers—not microservices—until the team and load demand a split**.
