# 09-d · Concurrency: stale pages, two devices and lost locks

**Needs:** 01 fixtures; local `next dev` for `[local]`. `[two-browser]` cases use one extra isolated page.
**Personas:** B1, B2, B3, H1, H2.
**Docs under test:** `lib/scheduling/availabilityPolling.ts` (poll 60 s + 10–15 s jitter), `app/api/scheduling/availability-with-allocation/[consultantId]/route.ts` (ETag / 304), `lib/booking/allocation/guards.ts`.

Grid-level "Just taken" painting is HM-27; the checkout bounce copy is CO-04; a green reschedule time taken before submit is CO-57; availability edited in two tabs is HM-12 (suspected lost update). These cases cover the API contracts and the stale screens those don't.

## CC-35 — The grid's ETag: 304 while nothing changes, new data after a booking `[local]` `[two-browser]`

**Why it matters:** the poll is how a stale grid heals without a reload. Salvaged from old 016 Phase 1.

**Steps:**

1. As B1 call `GET /api/scheduling/availability-with-allocation/[H1 cid]?startDateInUtc=…&endDateInUtc=…&timezone=Asia/Kolkata` for next week; record the `ETag` and that Wed D+9 11:00 IST is free.
2. Repeat with `If-None-Match: <ETag>` → `304`.
3. B2 books Wed D+9 11:00 IST (Mock Pay).
4. B1 repeats step 2 with the old ETag.
5. In the UI, keep B1's booking page open and visible; time how long 11:00 takes to disappear without a reload.

**Expect:** 2: `304` with the same `ETag` and `Cache-Control`. 4: `200` with a **new** ETag and 11:00 no longer offered. 5: gone within about 70–75 s (60 s poll + jitter); record the observed time.

**Probe further:** hide the tab (switch to another page) for 2 minutes and return: does it refetch at once (return refetch), or wait for the next tick? Does a "Last updated" label tell B1 how fresh the grid is (HM-40)?

## CC-36 — A stale booking page buys a taken slot: the 409 contract `[local]` `[two-browser]`

**Why it matters:** the loser must be told plainly and never charged. The UI copy is CO-04; this is the response body.

**Steps:** after CC-35 step 3, B1 (never refetched) `POST /api/checkout` for Wed D+9 11:00 IST.

**Expect:** `409`, body `code: "SLOT_TAKEN"`, `errorType: "AVAILABILITY_ERROR"`, `yourCardWasNotCharged: true`, error "Someone else booked this time moments ago. Your card was not charged.". `SELECT count(*) FROM "Payment" WHERE "userId" = :b1 AND "appointmentId" IN (… occurrences at that time …)` = 0.

**Probe further:** B1's checkout keeps the chosen plan and date after the bounce?

## CC-37 — A stale allocate tab after the other tab saved `[two-browser]`

**Why it matters:** salvaged from old 009 Phase 5; the second tab's count of tentative sessions is stale.

**Setup:** a webinar with no confirmed sessions (H2, unsold draft webinar) or a consultation request with requested times (tentative count > 0). Two H2/H1 pages on its allocate page.

**Steps:** tab 1 saves. Tab 2 saves with the `expectedTentativeSlotCount` it loaded (copy the body from tab 2's network panel). Then send one allocate with `expectedTentativeSlotCount: 99`.

**Expect:** tab 2: `409` `errorCode: "RESCHEDULE_STATE_CHANGED"` (or `ALREADY_ALLOCATED`), no slot row changed. The `99` call: `409` `RESCHEDULE_STATE_CHANGED`, nothing changed.

**Probe further:** tab 2's toast copy: "changed elsewhere, reload" or a raw code?

## CC-38 — The allocate page of a booking the buyer has since cancelled

**Why it matters:** a stale "Needs you" item leads the host to act on a dead booking.

**Setup:** a pending request from B3 to H1. H1 opens its allocate page and picks a time. B3 cancels the request in another page.

**Steps:** H1 saves.

**Expect:** a typed `409` (record `errorCode`; `ILLEGAL_TRANSITION` likely) with copy saying the request is no longer open; no occurrence created. H1's home "Needs you" drops the item on reload.

**Probe further:** does the allocate page notice the cancel before the save (poll or focus refetch)?

## CC-39 — Answering a proposal the other side already answered `[two-browser]`

**Why it matters:** a stale Accept must not resurrect a withdrawn proposal.

**Setup:** H1 proposes a time to B1 (CO-60). B1 opens the proposal page. H1 withdraws it in another page.

**Steps:** B1 clicks Accept on the stale page.

**Expect:** `409` `PROPOSAL_NOT_OPEN` with human copy; the original time unchanged; no new occurrence.

**Probe further:** what does B1's page show after the 409: the current state (original time kept) or just an error?

## CC-40 — A stale webinar picker over a 1:1 booked meanwhile `[local]` `[two-browser]`

**Why it matters:** the host picker's "Free" label is a snapshot; the server must refuse a clash.

**Setup:** H2 opens the webinar editor's time picker showing Mon D+14 18:00 IST as Free. Meanwhile B2 books H2 at that time (needs an H2 1:1 plan; if H2 has none, use H1 with an H1 webinar).

**Steps:** H2 saves the webinar at 18:00 without refreshing the picker.

**Expect:** a typed refusal (`SCHEDULE_CONFLICT`, 409; record) with copy naming the clash; the webinar isn't saved at 18:00. WE-12 covers the non-stale version.

**Probe further:** after the refusal, does the picker refresh and mark 18:00 Busy?

## CC-41 — A cancel dialog left open while the expert moved the session `[local]` `[two-browser]`

**Why it matters:** a move can cross a tier boundary; the bound quote must catch it.

**Setup:** B1's paid booking 30 h out. B1 opens the cancel dialog (quote 100 %). H1 moves the session to 20 h out (owner-approved shift standing in for an accepted proposal, or a real proposal B1 accepts in a third step: record which).

**Steps:** B1 confirms the stale dialog.

**Expect:** `409` `REFUND_QUOTE_CHANGED` with the new figure (50 %); nothing committed. CO-75 covers a clock-driven change; this one is driven by the other party.

**Probe further:** the re-shown dialog explains why the figure changed?

## CC-42 — The pattern scheduler saved after a seat sold in another tab `[local]` `[two-browser]`

**Why it matters:** the sold-class rule must hold even for a page loaded while unsold.

**Setup:** H2's unsold scheduled class; H2 opens the pattern scheduler and edits the pattern. B3 buys a seat in another page.

**Steps:** H2 saves.

**Expect:** `409` `USE_RETIME` with copy pointing to "Move upcoming sessions"; sessions unchanged; B3's seat intact. CL-26 covers the stop panel on a fresh load.

**Probe further:** does the scheduler show the stop panel on its next refetch without a reload?

## CC-43 — The same buyer pays on one device after paying on another `[local]` `[two-browser]`

**Why it matters:** two tabs on one checkout must not buy twice.

**Setup:** B2 opens S-08's checkout for Thu D+10 18:00 IST in two pages (same account). Each page has its own client key.

**Steps:** pay in page 1 (Mock Pay). Then pay in page 2.

**Expect:** page 2 gets `409` `SLOT_TAKEN` (the time is now B2's own booking) or a duplicate-booking refusal; record the copy. It must not say "someone else booked this". One payment, one booking.

**Probe further:** does page 2's copy offer "View your booking"?

## CC-44 — A lost lock refuses instead of writing `LOCK_LOST`

**Why it matters:** a Redis hiccup mid-write must abort, not write unserialised.

**Setup:** can't be produced on demand from the browser. Owner drill only (local): add latency or kill Redis during an approval, an abandon or a withdraw-approval (the doors that renew the appointment lock per attempt).

**Steps:** owner triggers the door during the outage.

**Expect:** `409` `LOCK_LOST` with human copy ("try again" style); no partial write (R-03 unchanged). Without the drill: NEEDS-OWNER-RUN; the runner only records the code's presence in `lib/booking/abandon.ts`, `withdraw-approval` routes and `lib/booking/allocation/classify.ts`.

**Probe further:** what does the user see for `LOCK_LOST`? A developer word in a toast is ERROR-HANDLING.
