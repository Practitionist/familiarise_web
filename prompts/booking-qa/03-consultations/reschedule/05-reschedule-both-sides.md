# 03-e · Consultations: rescheduling (the consultee moves it; the expert moves it; the caps)

**Needs:** 01 (F-AV1, S-08), local mock pay for the fixture bookings. H1 in "Instant booking".
**Personas:** H1 (IST), B1 (IST), B2 (Europe/London), B3 (America/Los_Angeles).
**Docs under test:** `docs/booking/07-rescheduling-flow.md` ("The response loop", "Confirming a proposal…", "Expiry restores…"), `.claude/skills/booking/SKILL.md` doctrine §1 (reschedule paragraphs), `app/api/appointments/[appointmentId]/reschedule/route.ts`, `lib/booking/reschedule-caps.ts`.

Rules under test (verified in code):

- Each release opens a `RescheduleRequest` (with times or "Any time works"). One open request per booking (`openForAppointmentId`).
- The session must start at least 24 h from now (409 `RESCHEDULE_WINDOW`: "Cannot reschedule within 24 hours of the meeting. The earliest meeting starts in N hours."), and each new time at least 24 h away (400 `PROPOSAL_TOO_SOON`).
- Consultee picks a time where the expert is free and published ("green"): the move **auto-confirms** (`AUTO_ACCEPTED`). Otherwise it waits for the expert (`PENDING_REVIEW`).
- A proposal's deadline is min(now + 72 h, the released session's start − 24 h).
- Caps: the consultee may move each session at most 2 times (422 `MAX_RESCHEDULES_EXCEEDED`); requests that moved nothing (withdrawn, declined or expired with a restore) don't count.
- Payment is untouched by a move.

Fixtures for this file `[local]`: as B2 book S-08 at Thu D+3 10:00 IST (**R-1**); as B3 book S-08 at Fri D+4 10:00 IST (**R-2**); as B1 book S-08 at Mon D+7 17:00 IST (**R-3**). Record ids. After every case: R-03 (watch `RescheduleRequest`), R-04 (payment unchanged), R-05, R-07.

## CO-46 — Consultee picks a free time: the move confirms at once

**Why it matters:** the fast path; the expert's published hours are standing consent.

**Steps:**

1. As B2 open R-1 → **Reschedule** (`/dashboard/consultee/[B2 uid]/appointments/[R-1]/reschedule`). Read the hint ("Green means your consultant is free — choosing one of those confirms straight away. Anything else is sent to them to approve.") and the notice chip.
2. Pick Thu D+3 12:00 IST (shown as 06:30 GMT). Submit **Request this time**.
3. Read the toast and the detail page.

**Expect:**

- DB: one `RescheduleRequest` `AUTO_ACCEPTED`, `initiatorRole = 'CONSULTEE'`, `releasedSessions` lists ordinal 1 at the old start, `resolvedAt` set, `openForAppointmentId` NULL. The booking's live occurrence is at 06:30Z (record whether it's the same row moved in place or a new row with the old one `RESCHEDULED`).
- Payment unchanged (same row, same amount). R-05 zero rows.
- B2's detail shows the new time in London time; RescheduleProposalCard title "New times confirmed" (or similar).

**Cross-check:** H1 sees 12:00 IST on home, appointments and detail; bell + outbox "APPOINTMENT_RESCHEDULED" to both; reminders re-timed (old reminder rows cancelled or re-aimed; record).

**Probe further:** does H1 learn the reason B2 gave? Does B2's success copy say "confirmed" before the server confirmed (optimistic copy)? Count this move toward B2's cap (CO-53).

## CO-47 — Consultee proposes a time the expert hasn't published: it waits

**Why it matters:** outside published hours needs the expert's consent; the original slot is released but still held.

**Steps:** as B3 open R-2's reschedule page. Pick a cell that isn't green, e.g. Sat D+5 15:00 IST (outside Saturday's 10:00–14:00) if the grid allows picking it; if the grid won't let a buyer pick unpublished time, record that and use `evaluate_script` to POST `/api/appointments/[R-2]/reschedule` with `proposedSlots: [{ startsAt: "<Sat D+5>T09:30:00Z", endsAt: "<Sat D+5>T10:30:00Z" }]`, reason "qa-CO-47".

**Expect:**

- `RescheduleRequest` `PENDING_REVIEW`, `expiresAt` = min(now + 72 h, Fri D+4 04:30Z − 24 h) (compute and compare), `originStatus` recorded; the original occurrence `completionStatus = 'RESCHEDULED'`, `isTentative = true`, not deleted.
- B3's card: "You asked to reschedule" with "Needs an answer by <time in Los Angeles>".
- H1's Requests row: "<B3> asked to move · proposed Sat <d> 3:00 pm IST" with **Accept new times**, **Keep the original time**.
- H1's grid shows the original as "Being moved" (HM-25).

**Probe further:** if the buyer grid can't select unpublished times at all, the hint's "Anything else is sent to them to approve" is misleading (FALSE-INFO P2). Report exactly what's selectable.

## CO-48 — The expert accepts the proposal

**Steps:** as H1 click **Accept new times** on CO-47's row.

**Expect:** `POST /api/appointments/[R-2]/reschedule/respond` `{ action: "accept" }` → 200; request `ACCEPTED`, `resolvedAt` set, lock cleared; one live confirmed occurrence at Sat D+5 09:30Z; payment unchanged; both told. Accepting again → 409 (dead CAS edge, salvaged from old 007 Test 2.2).

**Cross-check:** B3 (Los Angeles: Fri night 01:30 PST? compute) and H1 (Sat 15:00 IST) agree with the DB.

**Probe further:** the new time is outside H1's hours: does H1's appointment show a hint that it's outside published hours? Is the reminder re-timed?

## CO-49 — The expert keeps the original time (declines)

**Why it matters:** a decline restores the booking exactly and costs the consultee nothing.

**Setup:** R-2 again: B3 proposes another out-of-hours time (Sun D+6 11:00 IST) the same way.

**Steps:** as H1 click **Keep the original time**. Read the dialog ("Decline the proposed times?" / "The released sessions go back where they were. Any whose original time can no longer be restored stay in your allocate queue to place at new times.") and confirm **Decline proposal**.

**Expect:** request `DECLINED`, `restoredAt` set; the released row back to `SCHEDULED`, non-tentative, at the pre-proposal time; parent status back to `originStatus`. This request does not count toward B3's cap (CO-53).

**Cross-check:** B3 sees "Proposal declined" and the original time; H1's grid shows a normal Booked block.

## CO-50 — The consultee withdraws their own proposal

**Steps:** B3 proposes again (out of hours) on R-2; then on B3's card click **Withdraw request** (`POST …/reschedule/withdraw`). Then as H1 call the withdraw route on a new B3 proposal.

**Expect:** first: `WITHDRAWN`, restored, `restoredAt` set, not counted. Second: 4xx `NOT_INITIATOR` (or the anti-oracle 404); proposal still open; withdraw it as B3 afterwards.

**Probe further:** H1's row disappears without a stale "Accept" button (refresh H1's inbox).

## CO-51 — "Any time works": a release without times, placed by the expert

**Why it matters:** preference-only releases are legal for consultations (`PROPOSAL_REQUIRED` applies only to trials); the expert's placement closes the request.

**Steps:**

1. As B1 open R-3's reschedule page; tick **Any time works**; set "Preferred time of day" morning and "Preferred days" Tue/Wed; submit.
2. As H1 open Requests: the row reads "<B1> asked to move · any time works — you pick" with **Pick a new time**. Open it (allocate page) and pick Tue D+8 09:00 IST. Save.

**Expect:**

- After 1: `RescheduleRequest` `PENDING_REVIEW` with no proposed slots, preferences stored; R-3's occurrence released (`RESCHEDULED`, tentative).
- After 2: the request closed by the allocator (`resolveConsumedPreferenceRequests`; status record), the occurrence at Tue D+8 03:30Z confirmed; history token `schedule:reschedule`.

**Probe further:** does B1 see the preferences echoed back? Does H1's allocate page show them (MISSED-OPPORTUNITY if H1 can't see "mornings, Tue/Wed")?

## CO-52 — The 24-hour rule, both ends

**Why it matters:** inside 24 h a move is refused; a new time inside 24 h is refused; the UI must say so before the click.

**Steps:**

1. Owner-approved: shift R-1's live occurrence to start in 23 h (UTC half hour).
2. As B2 open the reschedule page; read what it shows. Try to submit any time (via `evaluate_script` if the page blocks it).
3. Restore R-1 to ≥ 48 h away. As B2 propose a time 20 h from now.

**Expect:** 2: the page explains the 24-h rule up front (chip "not within 24 h of the start · not refunded"); the API answers 409 `RESCHEDULE_WINDOW` "Cannot reschedule within 24 hours of the meeting. The earliest meeting starts in 23 hours." 3: 400 `PROPOSAL_TOO_SOON` "New times must be at least 24 hours away." No request rows from either.

**Probe further:** what does the consultee do inside 24 h? The page should point to cancel (with its tier) or messaging. MISSED-OPPORTUNITY if it just disables.

## CO-53 — The consultee's cap: two moves per session

**Why it matters:** caps count real moves only; withdrawn, declined and restored requests are free.

**Steps:** on R-1 (moved once in CO-46; CO-52 didn't create a request), as B2 auto-confirm a second move (another green time). Then try a third.

**Expect:** second: `AUTO_ACCEPTED`. Third: 422 `MAX_RESCHEDULES_EXCEEDED` "You can move each session at most 2 times." Count in SQL: two counted releases for ordinal 1 (`countedReleases`). For R-2, CO-49/CO-50's declined and withdrawn requests must not count: B3 can still auto-confirm twice.

**Probe further:** does the page warn "this is your last move" before the second? Does the third attempt's page say why instead of failing on submit?

## CO-54 — One open request at a time

**Steps:** as B3 propose an out-of-hours time on R-2 (stays open). Propose again.

**Expect:** 409 `RESCHEDULE_ALREADY_OPEN` "A reschedule request is already open for this booking." The UI shows the open card ("You already have a reschedule open"). Withdraw it afterwards.

## CO-55 — A proposal nobody answers expires and restores `[sweep]`

**Why it matters:** expiry must put the booking back, never leave it released or refund it.

**Steps:**

1. B3 proposes an out-of-hours time on R-2.
2. Owner-approved: `UPDATE "RescheduleRequest" SET "expiresAt" = now() - interval '1 minute' WHERE id = :rrId;`
3. Before the sweep, as H1 click **Accept new times**.
4. NEEDS-OWNER-RUN the hourly reschedule-proposal expiry (`expireRescheduleProposals`, job slug `reschedule-proposals`).

**Expect:** 3: 409 `PROPOSAL_EXPIRED` (accept refuses a lapsed proposal before touching the allocator); nothing moves. 4: request `EXPIRED`, booking restored (`restoredAt`), not counted, one notice to each side. No refund.

**Probe further:** between 2 and 4 the request is still `PENDING_REVIEW` for up to an hour: what does H1's row show (a live Accept button that will fail)?

## CO-56 — Withdraw meets a taken original time

**Why it matters:** if the original time was taken meanwhile, withdraw must refuse and leave the proposal open rather than double-book.

**Setup:** B3 proposes out-of-hours on R-2. R-2 is no longer at Fri D+4 04:30Z: CO-48 moved it to Sat D+5 09:30Z and CO-49/CO-50 restored it there, so read its released row's current `startsAt`/`endsAt` with R-03 first (released but still occupying). Owner-approved: move another QA booking's live occurrence (e.g. HM-27's or CO-05's) onto exactly that window to simulate the time being taken. Record both windows and what you moved.

**Steps:** as B3 click **Withdraw request**.

**Expect:** 409 `ORIGINAL_TIME_TAKEN`; the proposal stays open; the UI tells B3 the original time is gone and what to do (pick another / wait for the expert). Restore the moved occurrence afterwards. The decline variant (parks the booking) is CO-87.

## CO-57 — A green time taken between page load and submit

**Steps:** `[two-browser]` B2 opens R-1's reschedule page (if R-1 is capped, use a fresh booking) and picks a green time; in the second page B3 books that time; B2 submits.

**Expect:** 409 `TIMES_TAKEN` "Some of the times you picked were just taken. Your booking keeps its original time — pick another time."; `takenSlotStarts` names it; the request is withdrawn on the spot (costs no move); the original stays confirmed.

## CO-58 — Reschedule POST is idempotent

**Steps:** as B1 on a fresh booking, POST `/api/appointments/[aid]/reschedule` twice with the same `Idempotency-Key` and body (a green time); then the same key with a different time.

**Expect:** second call replays with `Idempotent-Replay: true` and an identical body; exactly one `RescheduleRequest`. Third: 4xx `IDEMPOTENCY_KEY_REUSED`. Parallel double submit is 09.

## CO-59 — A booking waiting for payment can't be moved

**Steps:** on an `APPROVED_PENDING_PAYMENT` booking (03-d), as the consultee open Reschedule / POST the route.

**Expect:** 409 `PAY_LINK_LIVE` "This booking is still waiting for payment. Pay for it or cancel it first, then reschedule." The detail page hides Reschedule or explains it. Then (owner-approved) set the `PENDING` payment's `expiresAt` to 1 minute ago and POST again: the block no longer applies, because only a live, unexpired payment holds the booking.

---

**Part 2 — Consultations: the expert moves a booking, and the caps**

**Needs (part 2):** book the fresh fixtures below, local mock pay. H1 in "Instant booking".
**Personas:** H1 (IST), B1 (IST), B2 (Europe/London), B3 (America/Los_Angeles).
**Docs under test:** `docs/booking/07-rescheduling-flow.md` ("The response loop"), `components/scheduling/time-picker-policy.ts` (`rescheduleConsultantPolicy`), `lib/booking/allocation/preference.ts`, `lib/booking/reschedule-caps.ts`.

Rules under test: an expert's proposal **never** auto-confirms ("merely being free is not consent to be moved"); the consultee accepts or declines; the expert may move one booking at most 2 times (409 `EXPERT_RESCHEDULE_CAP`); the allocator refuses to place times over the expert's own open proposal (409 `PROPOSAL_AWAITING_CLIENT`); only the counterparty may respond (anti-oracle 404 "No open reschedule request for this booking.").

Fixtures `[local]`: as B2 book S-08 at Tue D+8 10:00 IST (**R-4**); as B3 book S-08 at Wed D+9 10:00 IST (**R-5**); as B1 book S-08 at Thu D+10 10:00 IST (**R-6**). After every case: R-03, R-04, R-05, R-07.

## CO-60 — The expert proposes a new time; it waits for the client

**Why it matters:** salvaged from old 007 Phase 1. An expert-initiated move with both calendars free must still wait.

**Steps:**

1. As H1 open `/dashboard/consultant/[H1 cid]/appointments/[R-4]/reschedule`. Read the hint ("Green means you are free. Whatever you propose is sent to the consultee to accept.").
2. Pick Tue D+8 17:00 IST (free). Reason "qa-CO-60". Submit **Propose this time**.

**Expect:**

- `RescheduleRequest` `PENDING_REVIEW`, `initiatorRole = 'CONSULTANT'`, `openForAppointmentId = R-4`, `expiresAt` = min(now + 72 h, Tue D+8 04:30Z − 24 h); the original occurrence `RESCHEDULED`, tentative, not deleted. Not `AUTO_ACCEPTED`.
- B2's detail: "Your consultant proposed new times", the proposed time in London time (11:30 GMT), "Needs an answer by <London time>", buttons to accept or decline.
- H1's row: "You asked to move this to Tue <d> 5:00 pm IST · waiting for <B2>".

**Probe further:** what does B2 see on home (Needs-you)? Is the original time still shown so B2 can compare? The PR noted an old bug where a consultant proposal rendered as "Awaiting schedule confirmation" forever on the consultee side: check it's gone.

## CO-61 — The client accepts the expert's proposal

**Steps:** as B2 click **Accept new times** (`POST …/reschedule/respond` `{ action: "accept" }`). Then accept again via API.

**Expect:** 200; `ACCEPTED`, `resolvedAt`, lock cleared; one live confirmed occurrence at 11:30Z; payment untouched (one row). Second accept: 409. Both notified; reminders re-timed.

**Cross-check:** salvaged old 007 Phase 2 SQL: exactly one live slot at the proposed time; same appointment id; `Payment` count 1.

## CO-62 — The client declines the expert's proposal

**Steps:** as H1 propose again on R-4 (Tue D+8 19:00 IST). As B2 click decline; read the dialog ("Decline the proposed times?" / "Your original session times go back on your calendar. If one has been booked by somebody else in the meantime, your consultant places that session at a new time instead.") → **Decline proposal**.

**Expect:** `DECLINED`, `restoredAt`; the booking back at 11:30Z (the time after CO-61); counts as an expert move? Record: the decline restored, so by the cap rule it shouldn't count (`countedReleases`).

**Probe further:** does H1 get a clear "declined, original time kept" notice? Does B2's copy say "your consultant places that session at a new time instead" even when nothing was taken (confusing)?

## CO-63 — The expert withdraws their own proposal

**Steps:** H1 proposes on R-5 (Wed D+9 17:00 IST), then withdraws it from the row ("Withdraw my request") or `POST …/reschedule/withdraw`.

**Expect:** `WITHDRAWN`, restored, not counted. B3 notified (or not; record) and B3's card disappears.

## CO-64 — The allocator won't place over the expert's own open proposal

**Why it matters:** the client's consent is pending; placing a time anyway would bypass it.

**Steps:** H1 proposes on R-5 (Wed D+9 17:00 IST). Then as H1 open R-5's Manage timings (`…/appointments/[R-5]/timings`) or allocate path and save a different time; or `PATCH /api/bookings/consultations/[cid]/allocate` manual with Wed D+9 18:00 IST.

**Expect:** 409 `PROPOSAL_AWAITING_CLIENT` with copy telling H1 to withdraw the proposal first; nothing moves; the proposal stays open. Withdraw it afterwards.

**Probe further:** does Manage timings even offer Save while a proposal is open? If it does, report MISSED-OPPORTUNITY (should say "waiting for <B3>").

## CO-65 — The expert's cap: two moves per booking

**Why it matters:** repeated expert moves are a reliability problem; the third must push toward cancel (full refund).

**Steps:** on R-6: H1 proposes → B1 accepts (move 1); H1 proposes → B1 accepts (move 2); H1 tries a third.

**Expect:** third: 409 `EXPERT_RESCHEDULE_CAP` "You've already rescheduled this booking 2 times. If the time no longer works, cancel instead — the client gets a full refund." The page shows it before the submit if possible.

**Probe further:** does the consultant reschedule page show "moves left"? Do withdrawn/declined proposals stay free (CO-62, CO-63 didn't consume moves on R-4/R-5)? Query `countedReleases` equivalents in SQL: `SELECT status, "initiatorRole", "restoredAt", "releasedSessions" FROM "RescheduleRequest" WHERE "appointmentId" = :aid;`.

## CO-66 — Only the other party may answer

**Why it matters:** salvaged from old 007 Test 2.3 and Phase 4b; the respond route must not leak whether a proposal exists.

**Steps:** H1 proposes on R-5. Then: (a) H1 calls respond `{ action: "accept" }` on its own proposal; (b) B2 (not a party) calls respond on R-5; (c) B3 calls respond with `{ action: "maybe" }`; (d) B3 accepts; (e) B3 calls respond again.

**Expect:** (a) and (b): 404 "No open reschedule request for this booking." (identical body); (c) 400; (d) 200; (e) 404 (nothing open) or 409. Nothing moved by (a)–(c).

## CO-67 — The expert's "Any time works"

**Why it matters:** an expert release without times is preference-only; the expert then places it, but it must still not bypass the client.

**Steps:** on a fresh booking (B2, Fri D+11 10:00 IST), as H1 open its reschedule page, tick **Any time works**, submit. Then as H1 try to place a time via Manage timings.

**Expect:** a `PENDING_REVIEW` request with no times. Record what placing does: either the allocator places and closes it (preference-only requests are closed by placement) or `PROPOSAL_AWAITING_CLIENT` (only for proposals that name times). Record which and whether B2 is asked to consent. If the expert can silently move a paid booking this way, report it as a product question (consent) with evidence.

**Probe further:** what does B2 see while H1's "any time" release is open: a booking with no time? Quote it.

## CO-68 — An expert proposal across zones and near the deadline

**Why it matters:** "Needs an answer by" must be the true deadline in the client's zone; accepting after it must fail.

**Steps:** as H1 propose on a B2 booking 3 days out. Read "Needs an answer by" on B2's card. Compute min(now + 72 h, start − 24 h) and convert to London time. Then owner-approved: set `expiresAt` to 1 minute ago and have B2 click accept.

**Expect:** the shown deadline equals the computed one (to the minute) in London time with a zone label (format "EEE, d MMM yyyy · h:mm a zzz"); the late accept → 409 `PROPOSAL_EXPIRED`; the proposal later expires and restores (CO-55 rules).

## CO-69 — Decline door refused while a booking is being moved

**Why it matters:** a booking with an open proposal or released sessions is being moved; no "decline" can end it.

**Steps:** CO-66 accepted R-5's last proposal, so first have H1 propose a fresh time on R-5 (an expert proposal never auto-confirms) and confirm the request is `PENDING_REVIEW`. With that proposal open, as H1 `PATCH /api/bookings/consultations/[cid]` `{ status: "REJECTED" }`. Withdraw the proposal afterwards.

**Expect:** 409 `USE_RESCHEDULE_RESPOND` ("This booking is being moved, not requested. Keep the original time or answer the new one instead.").

## CO-70 — A month later: what the moved booking looks like

**Why it matters:** history and dashboards must tell the story of every move after the fact.

**Steps:** for R-1 (two consultee moves), R-4 (accepted + declined), R-6 (two expert moves): read B's and H1's detail pages, staff booking page and `BookingStatusHistory`.

**Expect:** each page shows the current time; history lists each proposal with who, when and outcome; no duplicate or illegal transitions; counts match the caps.

**Probe further:** does any page list "rescheduled 2 times" to the other party? Is that useful or shaming? Note only.
