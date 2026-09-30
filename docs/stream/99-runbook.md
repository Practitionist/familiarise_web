# Stream runbook

> **Status: current as of 2026-09-30.** Written alongside #1829. If a step here
> disagrees with the code, the code wins and this file is a bug — open an issue
> against it rather than working around it.
>
> **Read this before changing any Stream app setting.** `dev`, `preview` and
> `prod` share ONE Stream app (id 1366319, "Familiarise"). There is no
> environment separation. A "test" deletion is a real deletion, and the webhook
> hook is hard-pinned to `https://familiarisenow.com/api/stream/webhooks`, so a
> call created from a branch deploy delivers its events into **production**
> Postgres. There is a separate GitHub issue (#1873) for splitting the database;
> until that lands, treat every write to this app as a production write.

---

## 0. The one-paragraph version

Stream is a third party we depend on for every paid session, and we hold **no
chat or video state of our own in Postgres** — a `Meeting` row is a pointer, and
channels live only on Stream. So when Stream misbehaves, we cannot reconstruct
what happened; we can only detect that we cannot. This document is about the
detection and the two failure drills that actually occur.

**Two facts that drive every design decision here:**

1. **Stream drops a webhook 15 seconds after delivery starts.** 6 s per attempt,
   5 attempts, no backoff, `Retry-After` ignored. Only 408/429/5xx are retried —
   **a 401 or 403 is final, and a rejection is never written to a failover
   bucket.** So a mis-set secret loses the event permanently, with no vendor-side
   copy. We have no GCS/SQS failover configured (deliberate; see §7).
2. **The Maker tier is a hard pause, not overage.** Past 2,000 MAU (chat) or
   333,000 participant-minutes (video), _"additional users cannot connect."_
   There is no graceful degradation and no charge — calls simply stop working.
   §4 is the only thing standing between that and a bad afternoon.

---

## 1. Is it me, or is it Stream?

`GET /api/health`. The `stream` block:

| Field                                   | Meaning                                                             | Act on it when                                                               |
| --------------------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `configured: false`                     | `STREAM_API_KEY` / `STREAM_API_SECRET` missing                      | Fix the env. The app 500s every webhook.                                     |
| `reachable: null`                       | Not configured, so never probed                                     | Fix `configured` first.                                                      |
| `reachable: false, timedOut: true`      | The probe hit its own 2 s deadline                                  | Transient. If it persists, Stream is slow rather than down.                  |
| `breakerOpen: true`                     | The breaker's own state is OPEN                                     | §2.                                                                          |
| `breaker.state / .failures`             | Raw breaker state on the instance that served the probe             | `failures` climbing toward 5 → Stream is degrading before the breaker opens. |
| `probeFastFailed: true`                 | The probe never reached Stream because the breaker was already open | You are reading a cached verdict, not a fresh one.                           |
| `webhookSecret.configured: false`       | Neither `STREAM_WEBHOOK_SECRET` nor `STREAM_API_SECRET` resolves    | §3.                                                                          |
| `webhookSecret.matchesApiSecret: false` | An override is set and differs from the API secret                  | **§3. This is the 2026-08-12 failure mode.**                                 |

The `usage` block carries `mau`, `participantMinutes`, `peakConcurrency`,
`worstAlert` and `unmetered`. See §4.

> **Read the breaker caveat before you trust it.** The breaker state is a
> closure in the instance that served the request. A cold Netlify function has
> `failures: 0` and the breaker CLOSED, so on a cold instance `breakerOpen` is
> close to permanently `false` — it only reflects a _warm_ instance that has
> already seen failures. It is a real signal when it is true and weak evidence
> when it is false. The `usage.unmetered` and `probeFastFailed` fields exist to
> cover the gap. We deliberately did NOT move breaker state to Redis: it would
> re-couple Stream to Redis (the exact mis-attribution #1280 was filed to end),
> and a _shared_ OPEN has a larger blast radius than the failure it describes.

---

## 2. Drill: "Stream is down"

**Symptoms.** Users get `Video is temporarily unavailable. Please try again.`
(503) on join. Sentry shows `subsystem: stream` with the breaker-open class.

**What is already true.** The breaker stops us amplifying it, the join door
answers 503 rather than 500, Stream transients trickle in Sentry instead of
fire-hosing, and a `STREAM` / `VIDEO` `SystemEvent` row is written at the
transition and again at recovery, so the System-jobs console shows the outage
window.

**What you do.**

1. **Confirm it is Stream, not us.** `GET /api/health` → `stream.reachable`.
   Also check the [Stream status page](https://getstream.io/status/) and the app
   placement: this app runs on `gcp-us-east5.c1` and there is **no Indian
   region**, so latency from India is a standing condition and not an outage.
2. **Do not restart anything.** There is no cold-start fix for a vendor outage,
   and deploys make it worse (24–39 s of measured event-loop stall per cold
   instance, #1124).
3. **Check the drain path.** `actions/maintenance/drain-sessions.ts` ends live
   calls on an OFFLINE transition. If you are entering maintenance, the drain is
   what ends rooms — and it is _not_ the thing to reach for during a vendor
   outage, because ending a room mid-session is a refund conversation.
4. **What is safe to tell users.** "Video is temporarily unavailable, please
   retry." The join door already says this. Do not promise the session is saved:
   attendance is reconstructed from Stream's participant events, and if those
   events are not arriving the session's outcome will land on
   `INCONCLUSIVE` → `UNVERIFIED` → the ops queue rather than auto-completed. That
   is the designed outcome and it is a **hold**, not a loss.
5. **After recovery.** Check for `INCONCLUSIVE` / `UNVERIFIED` occurrences
   (`app/dashboard/(backoffice)/…/session-outcomes`). A vendor outage that spans
   a real session produces a queue of human decisions by design. Do not "clear"
   them in bulk.

**If the breaker is open but Stream is actually fine**, the instance is carrying
state it should not. A redeploy clears it. That is a symptom of the
per-instance design, not a bug to chase.

---

## 3. Drill: "we lost the webhook secret"

This is the 2026-08-12 outage, and it is the most expensive failure mode in the
subsystem: **total, silent, permanent loss of attendance, recording and
session-end events**, with no vendor-side copy.

**How it actually happened (the docs got this wrong for months).** The handler
_required_ a `STREAM_WEBHOOK_SECRET`. Stream signs with the **API secret** and
has never issued a separate signing secret. So the route 500'd on every delivery
for as long as the requirement existed. It was never "a secret was missing from
Netlify" — it was "we insisted on a secret that does not exist". The fix was to
stop requiring it, not to set it.

**Detect.**

1. `GET /api/health` → `stream.webhookSecret`. `configured: false` is the loud
   version (a 500 per delivery, plus a Sentry `fatal`). The quiet version is
   `matchesApiSecret: false` — an override is set to something wrong, and then
   every delivery 401s.
2. **`WebhookEvent` row count for `provider: 'stream'` stops advancing.** This is
   the single most reliable signal, and it is free:

   ```sql
   SELECT date_trunc('hour', "receivedAt") AS h, count(*)
   FROM "WebhookEvent" WHERE provider = 'stream'
   GROUP BY 1 ORDER BY 1 DESC LIMIT 24;
   ```

   A healthy live product shows a steady series. **A flat line at zero during
   business hours is this incident.**

3. Sentry: `stream.signature_invalid`, throttled to one event per 10 minutes per
   instance. It carries `hasOverride`, which distinguishes "the override is set
   to the wrong value" (a one-line env fix) from "the API secret is wrong" (a
   Stream-side issue).

**Respond.**

```bash
# 1. What is actually configured? (names only — never print values)
grep -o '^STREAM_[A-Z_]*' .env | sort

# 2. If STREAM_WEBHOOK_SECRET is set and is NOT your Stream API secret, that is
#    the bug. Remove it: the API secret is the correct and only default.

# 3. Confirm the hook is pointed somewhere real
npx tsx scripts/stream/ensure-webhook-subscription.ts --check
```

The override is kept only so the value _could_ be rotated independently if Stream
ever ships one. **Until that day it must equal the API secret, and the health
field says so.**

**Recover the lost events.** They are gone. Stream will not redeliver a 401 and
will not fail it over. What you can do is reconcile state from the API:

- `npx tsx scripts/appointments/auto-complete-appointments.ts` closes out
  finished occurrences from attendance evidence, and will mark ambiguous ones
  `INCONCLUSIVE`/`UNVERIFIED` for a human rather than paying them out blind.
- The orphan reconciler (`/api/cleanup/reconcile-sessions`) re-derives
  `Meeting.endedAt` from Stream for any open row.
- **Attendance for sessions during the window is unrecoverable.** The
  `firstJoinedAt` values simply do not exist. Say so plainly rather than
  reconstructing them; a wrong attendance row poisons the no-show classifier and
  the review gate downstream.

---

## 4. Drill: "the quota ran out"

**Symptoms.** Calls stop connecting with no error a user can act on, or Stream
answers 429 and our doors return `503 STREAM_QUOTA` with `Retry-After: 60`.
Hard pause with no charge at Maker tier; overage above it.

**Read the numbers.**

```bash
curl -s localhost:3000/api/health | jq '.usage'
# { worstAlert, unmetered, mau: {...}, participantMinutes: {...}, ... }
```

`worstAlert` is `null | "warning" | "error"`, escalating at 60 % / 80 % / 90 % of
the plan cap. The three alarms are deliberately **separate Sentry events**, so
an escalation is visible as its own transition rather than one event that stops
repeating.

**The two figures are not equally trustworthy, and the difference matters.**

- `mau` is **measured** — a 30-day marker written on the chat-token path. It
  counts users who minted a chat token, which is the closest thing to Stream's
  own definition available to us. Video-only participants are excluded so one
  session cannot double-count.
- `participantMinutes` and `peakConcurrency` are **upper bounds derived from
  `MeetingAttendance`**, computed by a nightly sweep. If `unmetered: true` or the
  row cap was hit, they are a **floor for that run, not an estimate** — the
  sweep says so in its own alert. Attendance under-counts whenever webhooks were
  lost (§3), so treat these as conservative, not authoritative.

**Budgets to watch.** Maker: 2,000 MAU, 333,000 participant-minutes, 125,000 feed
calls. Chat steps $399 → $1,049 → $1,849; the first cliff is the one that stops
product.

**Cost levers, in the order we should pull them.**

1. **`enable-noise-cancellation-any-team` must be revoked.** It is a
   per-participant-minute charge and it is a _grant_, so any participant can turn
   it on. `livestream` additionally has `noise_cancellation.mode: auto-on`, which
   starts the meter with no human action at all. §5.
2. **Transcription and closed captions must stay disabled.** `$8`/1k call-min on
   top of `$6`/1k for recording. Nothing in the app calls `startTranscription` —
   keep it that way, and do not grant it.
3. **`raw` / `individual` / `frame` recording must be disabled.** We record
   `composite` only. Raw is cheap per minute but produces a file nobody can play,
   and individual bills per participant.
4. **720p is the cap, not a default.** Stream bills the **aggregated received
   resolution** and documents that it _cannot_ cap it, so an 11-tile gallery
   drifts into 1080p/2K buckets with nobody changing a setting. That is the
   argument for moving webinars to the `livestream` call type (#1830), and
   `max_participants` is the blunt mitigation until then.
5. **RTMP/ingress is $15/1k call-min in each direction.** It is off on `default`
   and must stay off.

---

## 5. Operator actions: the four scripts that change Stream

Every one of these is **dry-run by default and requires `STREAM_TARGET_APP` to
write.** None of them is applied by CI. A passing `--check` proves _parity with
the script_, **not** that the hardening is on in production — the apply state is
recorded nowhere in the repo, which is why the checklist below exists.

| Script                                 | Changes                                                                                                                          | Guard                                              |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `ensure-call-type-grants.ts`           | `join-call`, recording, transcription, broadcasting and noise-cancellation grants per role                                       | `--apply --routes-are-deployed`                    |
| `ensure-call-type-settings.ts`         | Noise cancellation, the three recording modes, ingress, inactivity timeout, `max_participants`, target resolution, transcription | pre-write recording guard                          |
| `harden-unused-call-types.ts`          | Strips `audio_room` / `development` / `livestream`                                                                               | dry-run                                            |
| `ensure-recording-external-storage.ts` | Registers R2/Supabase external storage for Stream recordings                                                                     | `--apply` and `--delete` require `target-guard.ts` |
| `ensure-webhook-subscription.ts`       | The event subscription                                                                                                           | has a `--restore`                                  |
| `ensure-app-settings.ts`               | App-level flags                                                                                                                  | `--check` in CI                                    |

### Per-environment apply checklist

Copy this into the release ticket. Do not mark it done from a `--check`.

```
[ ] dev      grants --apply        settings --apply        harden --apply
[ ] preview  grants --apply        settings --apply        harden --apply
[ ] prod     grants --apply        settings --apply        harden --apply
[ ] all three:  --check now exits 0
[ ] all three:  /api/health stream.breaker present, webhookSecret.matchesApiSecret true
```

**Before `--apply` on prod:** get a second person to read the printed diff. These
writes are not reversible from git, and the pre-image files the scripts write to
`.stream-backups/` are the only rollback.

---

## 6. The recording pipeline and its clocks

Three independent clocks, which is the thing to remember:

| Clock                    | Column                                                   | Used by                                                       |
| ------------------------ | -------------------------------------------------------- | ------------------------------------------------------------- |
| Stream's own retention   | —                                                        | 14 days from the **call**, `cdn_expiration_seconds = 1209600` |
| Our "will expire" marker | `Recording.streamUrlExpiresAt`                           | the 410 gate, the transfer sweep, the backlog count           |
| Org retention            | `Organization.streamRecordingRetentionDays` (default 90) | `cleanup-old-stream-recordings`                               |

`streamUrlExpiresAt` is derived as **the earlier of** (call + 14 d) and
(now + 14 d). Deriving it from the row-write time instead — which is what the
code used to do — produced a ten-day window where the 410 gate passed and every
viewer was handed a dead Stream URL.

**Throughput is the standing risk.** The transfer sweep moves **25 files per run,
4 runs a day ≈ 100/day**, and there is no queue behind it — a batch is bounded,
not a schedule. Sustained permanent recordings above roughly that rate is a
data-loss machine, because Stream deletes at 14 days and a bounded batch cannot
keep up. Raise `batchSize` before assuming headroom: the bound is per run, so
the figure that matters is 25 × runs-per-day, and the alarm below fires on the
backlog rather than on the rate. The backlog alarm
(`countAtRiskPermanentRecordings`, 72 h horizon) is the thing to watch, and it
escalates at `error` level.

**Storage ceiling.** `RECORDING_MAX_OBJECT_BYTES` defaults to 5 GiB and **is
inert on the Supabase FREE plan**, which clamps every object to 50 MB globally
regardless of the bucket setting. A large recording therefore fails at upload,
is recorded on the row, and retries until the give-up. Do not raise the constant
and think you have fixed it — the plan has to move, or the bucket has to (R2 via
`ensure-recording-external-storage.ts`, or an upgrade).

---

## 7. What is deliberately NOT configured

**GCS webhook failover.** Stream supports `failover_config` → a Google Cloud
Storage bucket, and it would durably capture every event we fail to accept. It
is off, for two reasons: GCS is the only supported backend (no S3, R2 or Supabase
sink exists, and we already operate both of those — adding a third cloud for one
bucket is not worth it yet), and **it would not have protected us from the class
of outage we actually had.** A 401/403 is a deliberate rejection: it is not
retried and it never reaches the bucket. Failover covers "our endpoint was down
or slow". The sweeper, the 401 alarm and the replay window cover more of the real
failure space for zero new infrastructure. Revisit when the sweeper has run
clean in production for a month.

**Question to put to Stream support:** does a 401 behave like a 403 here (i.e. is
it excluded from the failover bucket)? The docs state the 403 case explicitly
and are silent on 401. We have assumed the conservative reading and our own
alarm covers the gap either way.

**Shared breaker state in Redis.** See §1. Deliberate.

---

## 8. Still open after #1829

Not bugs we forgot — decisions with owners:

- **Webinars still run on full-mesh `default`.** #1830 moves them to
  `livestream` + HLS. Until then `max_participants` is the only ceiling and
  aggregated resolution is uncappable.
- **Recording purchase is outside the ledger.** `RecordingPurchase` is
  deliberately not a `Payment` row, so a replay sale collects money with no
  `PaymentLeg`, no earnings, no GST and no payout. Documented intent, but it is
  unreconciled revenue and it is a finance decision, not a Stream one.
- **A 14-day VOD is unwatchable after 14 days** for `STREAM_ONLY` plans. That is
  the product policy, and the marketplace invariant correctly refuses to sell
  them — but the copy should say so before someone buys one.
- **No Stream instance in India.** `gcp-us-east5.c1` only.
- **`test:race` is 9/46.** Entirely pre-existing, entirely in checkout/booking
  concurrency, contains no Stream references. It is not a gate for this
  subsystem and it should not be read as one.
