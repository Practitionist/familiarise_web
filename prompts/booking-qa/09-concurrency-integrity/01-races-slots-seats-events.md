# 09-a · Concurrency: races on one slot, one seat, one event

**Needs:** 01 fixtures; local `next dev` for `[local]` (Mock Pay). Every race uses the parallel-fetch harness in [README.md](README.md) (two isolated pages, `[two-browser]`), then asserts the **final DB state** is one of the legal outcomes, never a mix. Run R-05 after every case.
**Personas:** B1 (IST), B2 (London), B3 (Los Angeles), B4, DR, H1, H2, H3.
**Docs under test:** `.claude/skills/booking/SKILL.md` (invariants), `docs/booking/` lifecycle pages, `docs/decisions/2026-11-09-scheduling-surfaces-and-feasibility.md` (sold-event rules).

Repeat each race **three times** with fresh fixtures (timing varies). Report each run.

## CC-01 — Two buyers, one consultation slot `[local]` `[two-browser]`

**Why it matters:** the slot lock is the only guarantee against a double booking.

**Setup:** S-08 (H1 60 min). Pick a free slot: Tue D+8 10:00 IST (04:30Z). Pages: B1 and B2, both on the slot's checkout.

**Steps:** fire `POST /api/checkout` from both pages at once (harness), each with its own `clientIdempotencyKey`, `isMockPayment: true`, the same `startsAt`/`endsAt` and weekly window id.

**Expect:** exactly one `200`; the other `409` with `code: "SLOT_TAKEN"`, `errorType: "AVAILABILITY_ERROR"`, `yourCardWasNotCharged: true`, error "Someone else booked this time moments ago. Your card was not charged.". Never a `500`. DB: one live occurrence at 04:30Z for H1; the loser has no `SUCCEEDED` payment on that slot (a `PENDING`/`EXPIRED` row is acceptable; record). R-05 zero rows.

**Cross-check:** H1's grid shows one Busy block; the loser's page shows "That time was just taken — pick another." and a refetched list.

**Probe further:** run it with one buyer being DR (dual role): does DR's consultant calendar also block the time once DR wins?

## CC-02 — Two buyers, the last webinar seat `[local]` `[two-browser]`

**Why it matters:** capacity must hold under contention; nobody pays for a seat they don't get. WE-25 is the basic version; this is the strict one.

**Setup:** an H2 webinar with capacity 3 and 2 seats `CONFIRMED` (B1, B3). Pages: B2 and B4.

**Steps:** both start the seat checkout at once (harness on `POST /api/checkout` for the webinar `eventId`), then both complete Mock Pay.

**Expect:** one seat `CONFIRMED`; the other gets a typed refusal before any charge (record the code; WE-25 names `EVENT_FULL`), or a `HELD` seat that never confirms and is released. Seat count = 3 exactly. R-04: no `SUCCEEDED` payment without a `CONFIRMED` seat.

**Cross-check:** H2's roster and the public "seats left" agree; the loser is offered the waitlist.

**Probe further:** while one seat is `HELD`, does the other buyer see "sold out" or "1 left"? What changes 15 minutes later if the holder walks away?

## CC-03 — Buyer checkout against the host allocating the same time `[local]` `[two-browser]`

**Why it matters:** the buyer's lock and the host's allocate must serialise on the host's calendar.

**Setup:** a pending consultation request for H1 (CO-20 style, B3, any time) waiting for allocation; pick a free slot Wed D+9 17:00 IST (11:30Z). Pages: H1 on the request's allocate page; B2 on S-08's checkout for 11:30Z.

**Steps:** at once: H1 `PATCH /api/bookings/consultations/[id]/allocate` with `{ "isAuto": false, "slots": [<11:30Z slot>] }` and an `Idempotency-Key`; B2 `POST /api/checkout` for the same time.

**Expect:** exactly one wins. Loser: the allocate answers `409` with `errorCode` `SLOT_TAKEN` or `TIMES_TAKEN` (record) and human copy; or the checkout answers `409` `SLOT_TAKEN`. One live occurrence at 11:30Z. R-05 zero rows.

**Probe further:** does H1's grid refetch after the 409, and does the tray keep H1's other picks?

## CC-04 — Two devices request the same window `[two-browser]`

**Why it matters:** two pending requests on one window both "hold" it; only one may.

**Setup:** H1 in "Review requests first" (03's switch) or a contended time that turns into a request (CO-24). Window Thu D+10 09:00 IST (03:30Z). Pages: B1 and B2. Salvaged from old 013 Phase 5.

**Steps:** at once, `POST /api/scheduling/request-for-approval` from both with different `Idempotency-Key`s (CO-20's body).

**Expect:** exactly one `201`; the other `409` `SLOT_TAKEN` (the body doesn't name the other buyer) or an account/slot lock `409` with `retryAfter`. One live tentative occurrence at 03:30Z.

**Probe further:** what does the loser's UI say? Does it suggest another time?

## CC-05 — Two buyers pick the same trial time `[two-browser]`

**Why it matters:** a free trial confirms instantly; a race would double-book H1.

**Setup:** S-11 (free trial). B3 and B4 have no trial with H1 (check `Trial` rows). Time Fri D+11 10:00 IST (04:30Z).

**Steps:** at once, `POST /api/trials` from both (copy the body from TR-01's network panel).

**Expect:** one trial `SCHEDULED`; the other `409` with "That time was just taken. Pick another time." (`SLOT_TAKEN`). One live occurrence. R-05 zero rows.

**Probe further:** repeat with the paid trial (S-12): one `AWAITING_PAYMENT` hold, the other refused; the hold blocks the time for others (TR-05).

## CC-06 — The host saves the same allocation from two tabs `[two-browser]`

**Why it matters:** the second tab must neither replace the first's sessions nor double them. Salvaged from old 009 Phase 4.

**Setup:** an unallocated paid subscription for H1 (SU-23). Two pages, both H1 on its allocate page with the same 3 picks.

**Steps:**

1. Tab 1 saves (`Idempotency-Key: K1`, `initialAllocation: true` if the client sends it; copy the body from the network panel).
2. Tab 2 saves the same body with `K2`.
3. Tab 1 re-sends with `K1`.
4. Both tabs save at the same moment with `K3` and `K4` on a fresh subscription.

**Expect:** step 2: `409` `errorCode: "ALREADY_ALLOCATED"` with a message naming the confirmed session count, or `RESCHEDULE_STATE_CHANGED`; sessions unchanged (same ids). Step 3: `200` replay, same appointment ids. Step 4: exactly one batch; the other `409`. R-06: `live_sessions = 3`.

**Probe further:** what does tab 2's UI say? It should say the booking changed elsewhere and offer a reload, not "Error 409".

## CC-07 — Allocate against the buyer cancelling `[local]` `[two-browser]`

**Why it matters:** sessions must not be placed on a cancelled booking.

**Setup:** an approved, paid consultation waiting for a time (CO-26 shape: H1 must place it). Pages: H1 allocate; B1 appointment detail with Cancel open.

**Steps:** at once: H1 allocate one slot; B1 `POST …/cancel`.

**Expect:** one of: (a) cancel wins: allocate `409` (record code; `ILLEGAL_TRANSITION` likely) and no live occurrence; or (b) allocate wins: the cancel then cancels a scheduled booking at its tier, with its refund. Never a live occurrence on a `CANCELLED` booking. Status history: one row per transition.

**Probe further:** in (a), H1's allocate page: does it explain the booking was cancelled?

## CC-08 — Host places a subscription session while the buyer releases one in the same week `[two-browser]`

**Why it matters:** the week cap is counted under a lock; two writers can push a week over its cap.

**Setup:** B1's weeks plan with week 1 at 2 of 3 placed. Pages: H1 allocate (picks the third session); B1 reschedule page (releases session 1, "Any time works").

**Steps:** at once: H1 saves; B1 submits the release.

**Expect:** final week 1 ≤ 3 live sessions (R-06 per-week query); either order is legal: the release then frees room, or H1's save is refused with `PLAN_WEEK_FULL` and copy. Never 4 in a week.

**Probe further:** the released session's `RescheduleRequest` and H1's new session: do the tray meters on both sides agree afterwards?

## CC-09 — Series move against a make-up for the same class `[two-browser]`

**Why it matters:** both write future class sessions; a make-up must not land where the series is moving, and the overlap constraint must hold.

**Setup:** H2's sold class (06) with one host-cancelled session owing a make-up. Pages: H2 (series move dialog, "Move upcoming sessions" by 2 days) and H2 in a second page (make-up picker).

**Steps:** pick a make-up time that collides with a moved session's new time; submit both at once.

**Expect:** one wins; the other is refused with `SCHEDULE_CONFLICT` (or `MAKEUP_EXISTS`, record) and human copy. No two live class sessions overlap. `hostCancelledAt` unchanged; no extra host miss from the move.

**Probe further:** do learners get one coherent set of notifications, or a "moved" and a "make-up" email that contradict each other?

## CC-10 — Re-time a sold webinar while a buyer leaves `[local]` `[two-browser]`

**Why it matters:** a leave quoted at the normal tier but committed after the re-time should be free (and vice versa).

**Setup:** H2's sold webinar (05) with B2's paid seat, ≥ 25 h out. Pages: H2 re-time dialog (move by a day); B2 leave dialog open.

**Steps:** at once: H2 re-times; B2 confirms the leave with the `expectedRefundPaise` the dialog showed.

**Expect:** either the leave lands first at its quote and the re-time proceeds without B2; or the re-time lands first and B2's leave answers `409` `REFUND_QUOTE_CHANGED` (quote moved to the free-leave figure) or simply refunds in full. The `Refund` equals whatever the committed quote was. Never a seat both left and re-seated.

**Probe further:** B2's emails: a "time changed" email after leaving is noise; record the order.

## CC-11 — Last seat bought while the host re-plans the class `[local]` `[two-browser]`

**Why it matters:** once a buyer seat exists the class can't be re-planned (`USE_RETIME`); the race decides which rule applies.

**Setup:** H2's unsold, scheduled class (CL-19 shape). Pages: B3 at checkout; H2 on the pattern scheduler with a changed pattern.

**Steps:** at once: B3 Mock Pay; H2 saves the pattern.

**Expect:** either the re-plan wins and B3 buys the new sessions (B3's seat lists the new times), or the seat wins and the re-plan answers `409` `USE_RETIME` with copy pointing to "Move upcoming sessions". The seat is never orphaned on deleted sessions; a `HELD` seat is never auto-confirmed.

**Probe further:** B3's confirmation email: does it carry the final times?

## CC-12 — The abandoned-payment sweep races a late capture `[sweep]`

**Why it matters:** "paid and lost" is the outcome to rule out. Salvaged from old 018 Phase 5.

**Setup (local, Razorpay test keys, owner):** three fresh lapsed `PENDING` seat payments (age `expiresAt` 1 h, owner-approved).

**Steps:** for each, the owner starts `abandoned-payments` and posts the signed `payment.captured` at the same instant.

**Expect:** each ends in exactly one of:

| Winner | Payment | Seat | Money |
| --- | --- | --- | --- |
| Capture | `SUCCEEDED` | `CONFIRMED` | one journal, no refund |
| Sweep | `SUCCEEDED` (late capture recorded) | released, not resold | `Auto-refund pending:` → `Auto-refunded:`, one `Refund` |

Never: `SUCCEEDED` with a released seat and no refund marker; `EXPIRED` with a confirmed seat; two refunds. If a pending marker remains, owner runs `retry-auto-refunds`.

**Probe further:** MO-66 covers the buyer's view of the sweep-wins row.

## CC-13 — Whole-class cancel while a seat takes a unit refund `[local]` `[two-browser]`

**Why it matters:** the whole-class refund reads each seat's ledger inside its transaction; a concurrent unit refund must not be counted twice.

**Setup:** H2's sold class with B3's seat and one host-cancelled session (B3 may skip the make-up). Pages: B3 on "Skip make-up" (refund one session); H2 on "Cancel class".

**Steps:** at once: B3 confirms skip make-up; H2 confirms the whole-class cancel.

**Expect:** B3's total refunds = units not delivered, once each: the `occ:` refund (if it won) plus `event-cancel:<classId>:pay:<paymentId>` for the rest; sum ≤ `amount`. MO-30 invariants pass.

**Probe further:** B3 gets two refund notices: do the amounts add up to what the class-cancel email promised?
