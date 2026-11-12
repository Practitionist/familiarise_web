# 09-c · Concurrency: duplicate submits and idempotency keys

**Needs:** the harness in [README.md](README.md); local `next dev` for checkout cases. R-07 for `IdempotencyRecord` rows.
**Personas:** B1, B2, B3, H1, AD.
**Docs under test:** `lib/api/idempotency.ts`, `lib/payments/operations/checkout-replay.ts`, `app/api/scheduling/request-for-approval/route.ts`, `lib/scheduling/allocate-route.ts`.

Which door uses which mechanism (from code):

| Door | Key | Replay behaviour |
| --- | --- | --- |
| `POST /api/checkout` | body `clientIdempotencyKey` (8–128 chars; minted server-side when absent) | same payment returned; a parallel loser hits the unique column and replays |
| `POST /api/scheduling/request-for-approval` | header `Idempotency-Key` (8–128 after trim) | same request returned; another user's key → `422 IDEMPOTENCY_KEY_REUSED` |
| `PATCH /api/bookings/<type>/[id]/allocate` | header `Idempotency-Key` → `Appointment.allocationIdempotencyKey` | same key replays the batch; a different key → `409 ALREADY_ALLOCATED` |
| `POST …/reschedule`, `POST …/occurrences/[oid]/return`, `POST /api/incidents/remedies/[id]/rebook` | header `Idempotency-Key` (10–255 chars) via `withIdempotency` (24 h) | replay with `Idempotent-Replay: true`; different body → `422 IDEMPOTENCY_KEY_REUSED`; still running → `409 IDEMPOTENCY_IN_FLIGHT`; only 2xx are recorded |
| `POST …/cancel` | none (state) | a second cancel by the same actor answers `200` with `replayed: true` |
| `POST /api/admin/refunds` | header `Idempotency-Key` (10–255) → `Refund.dedupeKey` | MO-32 |

Sequential replays already covered: CO-05 (checkout), CO-23 (request), CO-58 (reschedule). Don't repeat them.

## CC-25 — Checkout mints a key when the client sends none `[local]`

**Why it matters:** a null key deduplicates nothing; every keyless checkout would be unprotected. Salvaged from old 009 Phase 2.

**Steps:** as B1 `POST /api/checkout` (CO-01 body) for Wed D+9 09:00 IST with **no** `clientIdempotencyKey`, Mock Pay.

**Expect:** `200`; `SELECT "clientIdempotencyKey" IS NOT NULL FROM "Payment" WHERE "userId" = :b1 ORDER BY "createdAt" DESC LIMIT 1` → true.

**Probe further:** does the real UI always send a key? Check the network panel on a normal Mock Pay click.

## CC-26 — Two identical checkouts in flight with one key `[local]`

**Why it matters:** both can miss the replay lookup; the loser must replay, not 500. Salvaged from old 009 Phase 3.

**Steps:** fire two identical `POST /api/checkout` (same new key, Thu D+10 09:00 IST, Mock Pay) in parallel from one page (`Promise.all`).

**Expect:** neither is `500`; both bodies name the same appointment/payment; `SELECT count(*) FROM "Payment" WHERE "clientIdempotencyKey" = :key` = 1; one live occurrence.

**Probe further:** the Netlify/local server log: a P2002 caught and replayed is fine; an uncaught P2002 is a BUG.

## CC-27 — A request sent twice without a key is refused, not doubled

**Why it matters:** salvaged from old 013 Phase 1; without a key the slot check is the guard.

**Setup:** H1 in request mode (03's switch). Window Fri D+11 09:00 IST.

**Steps:** as B2 send CO-20's body twice in a row with no `Idempotency-Key`.

**Expect:** first `201`; second `409` `SLOT_TAKEN` (B2's own pending request occupies the window; record the message). One `Consultation` for B2 at that window. Clean up with `POST /api/bookings/[bookingId]/abandon` (`200`, request `CANCELLED`, hold released).

**Probe further:** the message names "you already have a session at this time"? A message blaming "someone else" would be FALSE-INFO.

## CC-28 — One request key, two calls in flight

**Why it matters:** salvaged from old 013 Phase 3.

**Steps:** as B2 send two calls with the same new key at once (`Promise.all`).

**Expect:** both `201` with the same `data.id` (the loser hits the unique `requestIdempotencyKey` and replays), or the loser `409` for the per-account lock with `retryAfter`. Never `500`. One row carries the key.

## CC-29 — A key belongs to its user and must be well formed

**Why it matters:** salvaged from old 013 Phase 4; a shared key must not leak or hijack another user's request.

**Steps:**

1. B3 sends a request with B2's still-live key from CC-28.
2. B2 sends `Idempotency-Key: short`.
3. B2 sends a 9-character key (`qa-cc-29a`) and a 256-character key to the reschedule door.

**Expect:** 1: `422` `IDEMPOTENCY_KEY_REUSED`, no row for B3, and the body doesn't reveal B2's request. 2: `400` "Invalid Idempotency-Key header". 3: `400` "Idempotency-Key must be between 10 and 255 characters" for both. Note the request door and the reschedule door accept different key lengths; a client key of 8–9 characters works on one and fails on the other (record as DESIGN/DOC-DRIFT if the client ever sends one).

**Probe further:** the request door also refuses characters outside `A–Z a–z 0–9 _ -` ("Idempotency-Key has invalid characters"); a UUID passes, a key with `.` or `:` doesn't. Does the browser client ever mint such a key?

## CC-30 — A reschedule double-submitted in parallel

**Why it matters:** the PR added `Idempotency-Key` replay to reschedule; parallel duplicates are the real double-click.

**Setup:** a fresh B1 booking ≥ 48 h out; a green time.

**Steps:** fire two identical `POST …/reschedule` with the same key at once. Then, after both settle, send the same key with the same body once more.

**Expect:** one `2xx`; the other `409` `IDEMPOTENCY_IN_FLIGHT` "Your earlier request is still being processed. Wait a moment, then refresh the page to see it." or a replay with `Idempotent-Replay: true`. One `RescheduleRequest`. The third call replays with `Idempotent-Replay: true` and an identical body. R-07 shows one record with `completedAt` set.

**Probe further:** does the UI disable the submit while in flight? Count requests on a fast double click.

## CC-31 — Returning a session: replay, changed body, and in flight

**Why it matters:** a return extends the plan by 7 days; a doubled return extends it twice.

**Setup:** B1's weeks plan with `sessionsReturned = 0` and two sessions ≥ 48 h out.

**Steps:**

1. Return session A with key `R1`; send it again with `R1`.
2. Send `R1` to session B's return door (different URL, same key).
3. Fire two returns of session B with key `R2` at once.

**Expect:** 1: the second is a replay (`Idempotent-Replay: true`), `sessionsReturned = 1`, `planEndsAt` +7 days once. 2: the scope includes the occurrence id (`booking.session-return:<aid>:<oid>`), so `R1` on another session is a **new** request (not a 422): record what happens. 3: one `2xx`, the other `409` `IDEMPOTENCY_IN_FLIGHT` or a replay; `sessionsReturned = 2`.

**Probe further:** the cap (two per plan) still applies across keys: a third return with a new key is refused (SU-69).

## CC-32 — A refused request frees its key for a real retry

**Why it matters:** only 2xx responses are recorded; a 4xx must not pin the user to a failure for 24 hours.

**Steps:** as B1, send a reschedule to a time inside 24 h with key `K` (refused by the 24-h rule). Then send the same key with the same body again; then the same key with a valid time.

**Expect:** first: the refusal (record code). Second: the same refusal re-computed (no `Idempotent-Replay` header). Third: `2xx` (a different body after a non-recorded failure is a fresh request, not a 422; record). R-07: no record pinned to the refusal.

**Probe further:** the code comment in `runAndRecord` says a thrown handler leaves the record in flight, but the code deletes it; if any retry answers `IDEMPOTENCY_IN_FLIGHT` after a refusal, that's a BUG P2.

## CC-33 — Cancelling twice, and cancelling someone else's cancel `[local]`

**Why it matters:** salvaged from old 016 Phase 3; a retried cancel must not refund twice or error.

**Setup:** a fresh B2 S-08 booking ≥ 24 h out.

**Steps:** B2 sends the cancel twice in a row. Then H1 cancels the same booking.

**Expect:** first `200`; second `200` with `replayed: true` and the same refund figure and status (not `NOT_CANCELLABLE`); one `Refund`. H1: `409` `NOT_CANCELLABLE`. Still one refund, no strike for H1.

**Probe further:** fire B2's two cancels in parallel: one refund, no 500.

## CC-34 — Every money and booking button survives a double click `[local]`

**Why it matters:** users double-click; the server is the last guard but the UI should be the first.

**Steps:** for each button, click twice within 200 ms and count requests in `list_network_requests`: Mock Pay (S-08 checkout), Request (request mode), Save on allocate, Send proposal (reschedule), Accept (proposal), Return to plan, Confirm cancel, Issue refund (AD), Join waitlist, Schedule N sessions (pattern scheduler).

**Expect:** one request per button (disabled while in flight), or two requests whose second is a replay/no-op. DB: one row per intended action for every button. Record any button that fires twice and writes twice (BUG) or fires twice and replays (MISSED-OPPORTUNITY: the button wasn't disabled).

**Probe further:** keyboard Enter twice on a focused button: same result?
