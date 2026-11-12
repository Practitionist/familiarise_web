# 04-b · Subscriptions: publish-time feasibility

**Needs:** F-AV2 (H2), F-AV4 (H4), F-AV1 (H1). Preview OK.
**Personas:** H2 (IST), H4 (Asia/Kathmandu), H1 (IST), B2 (Europe/London) for the GET endpoint.
**Docs under test:** decision 6 in `docs/decisions/2026-11-09-scheduling-surfaces-and-feasibility.md`; `lib/booking/feasibility.ts` (`assessFeasibility`, `planPublishFeasibility`, `buyerFeasibilityNotice`); `app/api/plans/subscriptions/[subscriptionPlanId]/feasibility/route.ts`.

**How the gate counts (so you can predict every number):** the expert's published hours for the next 4 plan weeks, cut on the expert's zone days, snapped inward to the UTC half hour, at most **1 session per day** for a subscription. Existing bookings are **ignored** when publishing (they are counted at checkout). `impossible` → 422 on publish; `tight` → saved with warnings.

| Host | Published hours (local) | On the lattice | Max 60-min sessions a week | Longest window |
| --- | --- | --- | --- | --- |
| H2 | Mon/Wed/Fri 18:00–21:00, Tue/Thu 07:00–09:00 IST | unchanged (IST is :30 off UTC) | 5 | 180 min |
| H4 | Mon–Sat 10:00–12:00 Kathmandu (04:15–06:15Z) | 04:30–06:00Z = 10:15–11:45 local | 6 | **90 min** |
| H1 | Mon–Fri 09:00–13:00 + 17:00–21:00, Sat 10:00–14:00 IST | unchanged | 6 | 240 min |

The 422 body is `{ error, code: "PLAN_NOT_FEASIBLE", reasons: [{code, message}] }`, where `error` = "This plan can't be delivered from your published availability. " + the reason messages + " Add hours, shorten the sessions or lower the sessions a week, or save it as a draft."

Every case: after a refusal, R-02 shows **no** new plan row; after a save, record `feasibilityWarnings` from the response.

## SU-11 — Too many sessions a week for the published days → 422

**Why it matters:** a plan the hours can never hold used to sell and then fail after payment.

**Steps:**

1. As H2, new subscription plan `qa-SU-11`: 6 sessions/week, 1 h, 4 weeks, ₹1,000. Publish.
2. Read the error shown in the editor (toast or inline). Check the network response.

**Expect:**

- API: `POST /api/plans/subscriptions` → 422 `PLAN_NOT_FEASIBLE`; `reasons[0].code = "TOO_FEW_OPEN_HOURS"`, message "The plan needs 6 sessions a week (at most 1 a day), but the published hours fit at most 5 in any week."
- UI: the editor shows the full `error` text in plain words, keeps the form filled, and offers a way to save as draft.
- DB: no plan row.

**Probe further:**

- Is "at most 1 a day" explained anywhere else in the editor? An expert may not know subscriptions cap at one session a day. **MISSED-OPPORTUNITY** if the editor doesn't say so before they publish.
- Does the editor scroll to or highlight a field? Which one would you change?

## SU-12 — Session longer than any published window → 422

**Steps:**

1. As H2, new plan `qa-SU-12`: 2/week, **3.5 h**, 4 weeks. Publish.

**Expect:**

- API: 422 `PLAN_NOT_FEASIBLE`; reason `SESSION_LONGER_THAN_WINDOWS`, "Each session is 210 minutes, but the longest published window is 180 minutes."
- DB: no row.

**Probe further:** 3 h (180 min) instead: does it publish? It should (fits Mon/Wed/Fri exactly), with `LOW_HEADROOM` if 3 a week, nothing if 2 a week (3 ≥ ceil(2 × 1.25)).

## SU-13 — Long sessions shrink the usable days → 422

**Why it matters:** a 2.5 h session fits only H2's 3-hour evenings, not the 2-hour mornings.

**Steps:**

1. As H2, new plan `qa-SU-13`: 4/week, **2.5 h**, 4 weeks. Publish.

**Expect:**

- API: 422; `TOO_FEW_OPEN_HOURS`, "The plan needs 4 sessions a week (at most 1 a day), but the published hours fit at most 3 in any week."

**Probe further:** does the copy help the expert see *why* Tue/Thu don't count? (The 2-hour mornings are shorter than 2.5 h.) **MISSED-OPPORTUNITY** if not.

## SU-14 — Tight but deliverable → 201 with LOW_HEADROOM

**Why it matters:** brittle plans are allowed but the expert should be warned.

**Steps:**

1. As H2, new plan `qa-SU-14`: **3/week, 2.5 h**, 4 weeks, ₹1,500. Publish.
2. Separately, new plan `qa-SU-14b`: 5/week, 1 h. Publish.
3. Separately, `qa-SU-14c`: 4/week, 1 h. Publish.
4. After each save, look for any warning on screen.

**Expect:**

- API: all three → 201. `qa-SU-14`: `feasibilityWarnings = [{ code: "LOW_HEADROOM", message: "The published hours fit only 3 sessions in the best week, so one busy day can leave a week short." }]`. `qa-SU-14b`: `LOW_HEADROOM` with "fit only 5" (5 < ceil(5 × 1.25) = 7). `qa-SU-14c`: `[]` (5 ≥ 5).
- UI: decision 6 says drafts and tight plans show their reasons as warnings. Record whether the editor shows **anything**. The editor code (`components/offerings/editor/*`) reads no `feasibilityWarnings`, so expect nothing: report **MISSED-OPPORTUNITY** (P2) and **DOC-DRIFT** quoting decision 6.
- DB: `status = PUBLISHED` for all three.

**Cross-check:** keep `qa-SU-14` published: SU-25 (room hint) and SU-44 (partial) use it.

**Probe further:** is `LOW_HEADROOM` visible to buyers in any form? It shouldn't be at publish time; checkout has its own notice.

## SU-15 — Kathmandu half-hour lattice shortens the usable window

**Why it matters:** H4 publishes two hours a day, but only 90 minutes sit on the UTC half-hour lattice. The expert sees "120" in their own hours and "90" in the refusal.

**Steps:**

1. As H4 (zone Asia/Kathmandu), new plan `qa-SU-15`: 1/week, **2 h**, 4 weeks. Publish.
2. New plan `qa-SU-15b`: 6/week, 1 h. Publish.
3. New plan `qa-SU-15c`: 6/week, **1.5 h**. Publish.

**Expect:**

- `qa-SU-15` → 422; `SESSION_LONGER_THAN_WINDOWS`, "Each session is 120 minutes, but the longest published window is 90 minutes."
- `qa-SU-15b` → 201; `LOW_HEADROOM` ("fit only 6 … in the best week"; 6 < ceil(7.5) = 8).
- `qa-SU-15c` → 201 with `LOW_HEADROOM` (90-minute sessions fit exactly 10:15–11:45 local).

**Probe further:**

- The refusal never says *why* 120 minutes of published time counts as 90. Report **MISSED-OPPORTUNITY** (P2): the copy should mention that sessions start on the hour or half hour UTC (:15/:45 in Kathmandu).
- Does H4's availability page warn that 10:00–12:00 local loses 15 minutes at each end? Deep zone matrix is 10's (`TZ-`); just report what you see.

## SU-16 — No availability at all: publish refused, draft saves with warnings

**Why it matters:** an expert may author plans before setting hours.

**Setup:** as H4, open Availability and switch **Weekly Recurring** to **Custom Schedule** with no custom dates (the weekly rows stay stored but publish nothing). If the switch is blocked, record `scheduleSwitchBlockedReason` and instead delete H4's weekly rows (write them down to restore).

**Steps:**

1. As H4, new plan `qa-SU-16`: 1/week, 1 h, 4 weeks. Publish.
2. Same plan, save as **draft**.
3. Restore H4's weekly availability (switch back to Weekly Recurring, or re-add rows). Run R-02 to confirm F-AV4 is back.

**Expect:**

- Step 1: 422 `PLAN_NOT_FEASIBLE`; reason `NO_AVAILABILITY`, "No availability is published, so no session can be placed."
- Step 2: 201, `status = DRAFT`, `feasibilityWarnings = [{ code: "NO_AVAILABILITY", … }]`.
- UI: after step 2, does the editor tell H4 the draft can't be published yet? Expect nothing (see SU-14): **MISSED-OPPORTUNITY**.

**Probe further:** while H4 has no hours, does H4's Offerings list flag the draft? Does Home show a "publish your hours" nudge?

## SU-17 — Publishing a draft runs the gate; a title edit of a published plan does not

**Why it matters:** the gate must catch the moment a plan goes on sale, but must not lock experts out of fixing typos on plans already selling.

**Setup:** `qa-SU-16` draft exists. H4 has hours restored. Then, as H4, publish a deliverable plan `qa-SU-17`: 1/week, 1 h.

**Steps:**

1. Switch H4 to Custom Schedule (no dates) again.
2. Publish the `qa-SU-16` draft (status DRAFT → PUBLISHED, no terms change).
3. Edit `qa-SU-17`'s **title only** to `qa-SU-17 renamed`. Save.
4. Edit `qa-SU-17`'s Sessions per week to 2. Save.
5. Restore H4's weekly hours.

**Expect:**

- Step 2: 422 `PLAN_NOT_FEASIBLE` (`NO_AVAILABILITY`); `qa-SU-16` stays DRAFT.
- Step 3: 200; title changed. The PUT computes `publishing = false` for an untouched published plan.
- Step 4: 422; `sessionsPerWeek` stays 1.

**Probe further:** in step 3 the response still carries `feasibilityWarnings: [NO_AVAILABILITY]` for a plan that is on sale. Nobody sees it (SU-14). Should the expert be told their live plan is undeliverable? Report as **MISSED-OPPORTUNITY**.

## SU-18 — Terms edit of a published plan beyond the hours → 422, plan unchanged

**Steps:**

1. As H1, `PUT /api/plans/subscriptions/[SU-01 id]` with `{ "sessionsPerWeek": 7 }` from the editor (change the field and save).

**Expect:**

- API: 422; `TOO_FEW_OPEN_HOURS`, "The plan needs 7 sessions a week (at most 1 a day), but the published hours fit at most 6 in any week."
- DB: `sessionsPerWeek` still 3; buyers' rows untouched.
- UI: form keeps the typed 7 with the error; reloading shows 3.

**Probe further:** does the editor's "active clients" notice (SU-08) still show while the error is up? Does the error mention that existing clients are unaffected either way?

## SU-19 — The feasibility endpoint: shape, auth and input rules

**Why it matters:** checkout reads this to warn buyers; it must never leak other buyers' times.

**Steps (as B2, signed in, via `evaluate_script`):**

1. `GET /api/plans/subscriptions/[SU-01 id]/feasibility`.
2. Same with `?startsAt=` + an ISO time 10 days ahead.
3. Same with `?startsAt=tomorrow`.
4. `GET /api/plans/subscriptions/does-not-exist/feasibility`.
5. Sign out; repeat step 1.

**Expect:**

- 1 and 2 → 200 `{ verdict, firstWeekPlaceable, sessionsPerWeek: 3, notice }` with header `Cache-Control: private, no-store`. For H1, `verdict` is `ok` (or `tight` only if 03/07 filled H1's weeks), `notice: null` when `ok`. No times, no ids, no names in the body.
- 3 → 400 "startsAt must be an ISO date-time".
- 4 → 404 "Plan not found".
- 5 → 401 "Unauthorized".

**Probe further:**

- Call step 1 thirty times quickly: when does the rate limiter answer, and with what status and copy?
- `startsAt` 200 days ahead: accepted? (Checkout refuses starts past 90 days, SU-27; the endpoint doesn't.) Report the mismatch if the checkout page lets you pick such a date and shows a notice for it.

## SU-20 — The endpoint counts today's bookings; the publish gate does not

**Why it matters:** the two numbers answer different questions and must not be confused.

**Setup:** `qa-SU-14` (H2, 3/week × 2.5 h, published). Find or create one confirmed H2 session on a Mon/Wed/Fri evening in the next 4 weeks: F-PL2's class series if it sits there, or ask 05 for its webinar, or as H2 publish a free 60-minute webinar `qa-SU-20` at the next Friday 19:00 IST (= 13:30Z = 13:30 London = 05:30 LA). Not Wednesday: 05's `qa-WE-05` needs next Wednesday 18:00–19:30 IST free.

**Steps:**

1. As B2, `GET /api/plans/subscriptions/[qa-SU-14 id]/feasibility`.
2. As H2, re-save `qa-SU-14`'s title (no terms change).

**Expect:**

- Step 1: `verdict: "tight"`, `firstWeekPlaceable` 2 or 3 depending on which week holds the booking, `notice` = "This expert currently has room for about 2 of 3 sessions a week. Sessions that can't be scheduled before the plan ends are refunded."
- Step 2: 200; `feasibilityWarnings` contains only `LOW_HEADROOM` (no `WEEKS_SHORT`, because publishing ignores bookings).

**Probe further:** "about 2 of 3" is the worst of 4 weeks, not the typical week. If only one week is short, is "currently has room for about 2" fair to the expert? Note it as a copy question for the owner, not a bug.

## SU-21 — The publish gate reads the expert's zone, not the browser's

**Why it matters:** day boundaries decide the 1-a-day cap.

**Steps:**

1. Emulate the browser in `America/Los_Angeles` (DevTools MCP `emulate`, if supported). As H1 (profile IST), publish `qa-SU-21`: 6/week, 1 h.
2. Publish `qa-SU-21b`: 7/week, 1 h.

**Expect:** `qa-SU-21` → 201 with `LOW_HEADROOM`; `qa-SU-21b` → 422 "fit at most 6". The same as with an IST browser, because the gate uses H1's profile zone.

**Probe further:** if emulation isn't supported, mark this case BLOCKED and say so; 10 (`TZ-`) owns the deep browser-zone matrix.

## SU-22 — Archive the feasibility fixtures

**Why it matters:** stray published `qa-` plans clutter the expert pages other cases read.

**Steps:**

1. As H2 and H4, archive every `qa-SU-1x` plan except `qa-SU-14` (used later) through the Offerings list.
2. Try to **delete** `qa-SU-14` after SU-44 has sold it.

**Expect:**

- Archive works; R-02 shows `archivedAt` set.
- Delete of a sold plan → 409 `OFFERING_IN_USE`, and the Offerings card offers Archive instead of Delete (its `canDelete` mirrors the server).

**Probe further:** does an archived plan disappear from the expert page while an existing buyer's appointment detail still shows its title?
