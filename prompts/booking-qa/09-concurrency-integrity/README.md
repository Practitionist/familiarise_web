# 09-concurrency-integrity (CC-)

What happens when two things happen at once, when a page is stale, when a request is sent twice, when someone calls a door they shouldn't, and whether the database still holds its invariants afterwards: races on slots, seats and events; two actions on one booking; idempotency keys; stale pages and lost locks; illegal transitions and the audit trail; authorisation by URL and API for every persona pairing; the maintenance freeze.

| File | Cases | What |
| --- | --- | --- |
| [01-races-slots-seats-events.md](01-races-slots-seats-events.md) | CC-01 – CC-13 | Two buyers one slot, last seat, buyer vs host, two request devices, two trial buyers, double allocate (keys), allocate vs cancel, week cap under two writers, series move vs make-up, re-time vs leave, seat vs re-plan, sweep vs capture, whole-class cancel vs unit refund |
| [02-races-on-one-booking.md](02-races-on-one-booking.md) | CC-14 – CC-24 | Cancel vs reschedule, accept vs withdraw, accept vs cancel, client vs expert cancel, approve vs abandon, withdraw approval vs pay, return vs reschedule, two returns at the cap, decline vs expiry sweep, pay vs link lapse, two admin refunds |
| [03-idempotency-and-duplicates.md](03-idempotency-and-duplicates.md) | CC-25 – CC-34 | Minted checkout key, parallel same key, keyless request duplicate, parallel request key, key ownership and format, parallel reschedule (`IDEMPOTENCY_IN_FLIGHT`), session-return replay, refused requests free the key, double cancel, double clicks on every button |
| [04-stale-pages-and-devices.md](04-stale-pages-and-devices.md) | CC-35 – CC-44 | Grid ETag/304 and poll, `SLOT_TAKEN` body, stale allocate tab, allocate after buyer cancel, stale proposal answer, stale webinar picker, stale cancel dialog after a move, stale pattern scheduler after a sale, same buyer two devices, `LOCK_LOST` |
| [05-illegal-transitions-and-audit.md](05-illegal-transitions-and-audit.md) | CC-45 – CC-53 | Cancel completed, reschedule/return cancelled, allocate expired/rejected, status PATCH doors, allocate validation, dead pay links, sold-event doors bypassing the UI, status history sanity, overlap invariant for every host |
| [06-authorisation-matrix.md](06-authorisation-matrix.md) | CC-54 – CC-66 | Other buyer by URL and API, other host, buyer on host doors, staff on party doors (`PLATFORM_CANCEL_DOOR_REQUIRED`), org owners across orgs, org learner downgrade, host-org operator scope, signed out, `?orgScope=`, admin and production-only doors, suspended learner, trial/webinar/class doors |
| [07-maintenance-freeze-owner-drills.md](07-maintenance-freeze-owner-drills.md) | CC-67 – CC-70 | What users see in DEGRADED, a checkout in flight survives, cancel after thaw refunds once, freeze between cancel and refund |

**Count:** 70 cases.

## Parallel-fetch harness

Open the second persona with `new_page` in an isolated context (`[two-browser]`, `_shared/00-read-first.md` §2). In **each** page, stage the request on `window` first, then release both within a few milliseconds:

```javascript
// page A and page B: stage (body copied from the real UI request in the network panel)
async () => {
  window.__qaFire = () =>
    fetch("/api/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" /* , "Idempotency-Key": "qa-CC-xx-a-<uuid>" */ },
      body: JSON.stringify(window.__qaBody),
    }).then(async (r) => ({ status: r.status, replay: r.headers.get("Idempotent-Replay"), body: await r.json().catch(() => null) }));
  return "staged";
};
// fire, in A and then in B, as close together as the MCP allows; never return or await the promise,
// or evaluate_script waits for A's answer before B starts:
() => {
  window.__qaStartedAt = Date.now();
  window.__qaResult = window.__qaFire();
  return "fired";
};
// then read each page's result in its own call:
async () => ({ startedAt: window.__qaStartedAt, result: await window.__qaResult });
```

The gap between the two starts is the difference of the pages' `startedAt` values; keep it within ~200 ms.

For a same-user race (double submit, two tabs of one account), use `Promise.all([window.__qaFire(), window.__qaFire()])` in one page. Record both statuses, codes and the elapsed time between them. If the two calls can't be fired within ~200 ms of each other, say so: a "race" that ran sequentially proves less.

**After every race:** R-03, R-04 when money moved, R-05, R-07 for keys. The final state must be one of the case's legal outcomes; a mix is DATA-INTEGRITY.

## Run order and environment

- After 03–08 (cases reuse their bookings and fixtures). 01 → 02 → 03 → 04 → 05 → 06; 07 only inside an owner's production maintenance window.
- `[local]` for anything paid (Mock Pay). Gateway-dependent races (CC-12, CC-19, CC-23) need Razorpay test mode and the owner.
- Sweeps named in a case (CC-12, CC-22, CC-23) are NEEDS-OWNER-RUN (12's README).
- Authorisation cases (06) run on a preview and write nothing unless a step says so.

## Salvaged from `prompts/booking-algorithm-tests/`

| Old | New |
| --- | --- |
| 002 §6.10 (two simultaneous checkouts, one wins) | CC-01 |
| 002 §6.1–6.3, 6.7 (401, 404, 403 non-participant reschedule/cancel) | CC-54, CC-55, CC-62 |
| 004 Phases 2–4 (availability rows and settings PUT by another consultant, a consultee, signed out) | CC-56 ("Also" block); own-availability validation stays in HM-01…HM-07 |
| 004 Phase 5 (checkout with another consultant's availability window) | CC-55 ("Also" block) |
| 006 Phase 6 (consultant-scoped booked slots) | CC-53 (overlap per host) |
| 008 Phases 1–3 (freeze with pending payment, cancel after thaw once, freeze mid-cancel) | CC-68, CC-69, CC-70 (+ CC-67 user view) |
| 009 Phases 1–3 (checkout key replay, minted key, parallel key) | CO-05, CC-25, CC-26 |
| 009 Phase 4 (`initialAllocation`, different vs same key) | CC-06 |
| 009 Phase 5 (`expectedTentativeSlotCount` stale tab) | CC-37 |
| 009 Phase 6 (`isAuto` required, manual without slots) | CC-49 |
| 013 Phases 1–5 (keyless duplicate, key replay, in-flight key, key ownership/format, two devices) | CC-27, CO-23, CC-28, CC-29, CC-04 |
| 013 Phase 6 (direct checkout two devices) | CC-01, CC-43 |
| 013 Phase 7 (seat re-buy after lapse) | MO-13 |
| 016 Phase 1 (stale grid, ETag 304, "just taken") | CC-35, CC-36 (UI copy: CO-04, HM-27) |
| 016 Phase 2 (stale quote) | CO-75, MO-17 |
| 016 Phase 3 (cancel twice, cancel someone else's cancel) | CC-33 |
| 016 Phase 4 (cancel races a reschedule answer) | CC-16 |
| 016 Phase 5 (caps count releases) | CO-53, CO-65 |
| 010 Phase 5 (`?orgScope=`) | CC-63, CC-60 |
