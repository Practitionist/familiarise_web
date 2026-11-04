## Preview QA — 2026-11-04

**Result: allocator fix passes the tested multi-day case, but grid sanity FAILS.** The preview still hides valid multi-day custom availability from the grid. This contradicts the description's “grid already accepts these placements” claim and should be addressed before treating the whole flow as verified.

Tested [deploy-preview-2580](https://deploy-preview-2580--familiarise.netlify.app) at **`92c62a46cb4afe6c3c7e2fcff55faf495504e14a`**. Netlify's PR comment matches the browser deploy ID `6aeb0d2871c8651e46dc1f3d`. Read the description, QA prompt, review body and inline feedback. The review's recurring-sweep laziness wording is corrected at this head.

UI testing used **Chrome DevTools MCP**, fixture CRUD/readback used **Supabase MCP** under the user's explicit mock-data authorization, and release checks used **Sentry MCP**. No Computer Use, application-code edits, card payment or gateway webhook replay.

### Setup and limits

- Created **QA-2580 fixture** through the consultant plan editor: **₹0**, one month, three one-hour sessions/week; persisted price **0**, `PUBLISHED`.
- Grace is currently **unverified**, `CUSTOM`, and her timezone is **Asia/Tehran**, rather than the prompt's assumed IST. Public expert page returns the not-found view. Free checkout was refused because the expert is unverified; it created no subscription or payment.
- To exercise allocation despite that setup blocker, inserted an isolated free subscription through Supabase: `debb2580-0002-4000-8000-000000000001`, pinned to **Asia/Kolkata**, first cycle **9–16 Nov**, plan end **9 Dec**, entitlement **12**. This validates the allocation UI/API/DB path, not the purchase-to-allocation journey.
- Snapshotted Grace's **36** original custom rows, temporarily removed them to isolate the search, and inserted one fixture row **13 Nov 18:00 → 16 Nov 10:00 IST** (`12:30Z → 04:30Z`, 64 hours). Used direct mock-data insertion because one submitted availability window is capped at **12 hours**; the prompt's single Fri→Mon POST is not accepted by the current write contract. Existing rows and profile fields were restored exactly afterward.

| QA case | Verdict | Evidence |
|---|---|---|
| 1. Grid sanity | **FAIL** | With the single 64-hour row present, `GET /api/scheduling/availability-with-allocation/<Grace>?purpose=book&startDateInUtc=2026-11-12T18:30:00.000Z&endDateInUtc=2026-11-16T18:30:00.000Z&timezone=Asia%2FKolkata` returned **200**, **`{"data":{},"leadMs":900000}`**. Expected Friday evening, Saturday, Sunday and Monday morning cells. Allocation grid showed no free cells from the row. As a control, shortening the same row to two hours made the same range query return **four available half-hour cells**. [Screenshot](https://github.com/Practitionist/familiarise_web/blob/qa-artifacts/qa/2580/multiday-grid.jpg?raw=true) · [snapshot](https://github.com/Practitionist/familiarise_web/blob/qa-artifacts/qa/2580/multiday-grid.snapshot.txt). Public expert heatmap was separately blocked by Grace's verification state. |
| 2. Multi-day subscription auto-schedule | **PASS — isolated allocation path** | Clicked **Auto-schedule this week** on desktop. Allocation PATCH returned **200**; UI said **“Sessions scheduled — All sessions were placed automatically.”** SQL confirmed three non-tentative `SCHEDULED` one-hour occurrences, one per IST day, entirely inside the row and well beyond lead time. Times below. |
| 3. Short-row negative | **PASS — mobile refusal** | Reset only the fixture appointment, shortened availability to **13 Nov 18:00–20:00 IST**, and used **390×844** viewport. Auto-schedule displayed **“Only 1 of 3 sessions fit in the free times. Open up more availability, or schedule the ones that fit now.”** No appointment/session was committed by the refused attempt. No placement outside the row. [Screenshot](https://github.com/Practitionist/familiarise_web/blob/qa-artifacts/qa/2580/short-row-mobile.jpg?raw=true) · [snapshot](https://github.com/Practitionist/familiarise_web/blob/qa-artifacts/qa/2580/short-row-mobile.snapshot.txt). |
| 4. Consultation horizon | **PARTIAL — allocator check passes** | Created an isolated free pending consultation fixture via Supabase and offered only **15 Jan 2027 18:00–20:00 IST**, more than eight weeks away. Mobile Auto-schedule PATCH returned **400**, `SLOT_SHORTAGE`, placeable **0**, required **1**. UI: **“No free time in the coming weeks fits this consultation. Open up more availability or pick a time yourself.”** SQL confirmed zero occurrences. The buyer's request/approval front door was not exercised. [Screenshot](https://github.com/Practitionist/familiarise_web/blob/qa-artifacts/qa/2580/horizon-mobile.jpg?raw=true) · [snapshot](https://github.com/Practitionist/familiarise_web/blob/qa-artifacts/qa/2580/horizon-mobile.snapshot.txt). |
| 5. Weekly regression | **PASS — read only** | Angela's existing approved subscription `cmu15oxm402dvc7yoly4zgxhi` has **3/4** sessions booked. Its allocation page and next-week grid loaded, availability GET returned **200**, and the settled grid showed **34 free half-hours**. No console errors. Did not allocate or edit this seed booking. [Screenshot](https://github.com/Practitionist/familiarise_web/blob/qa-artifacts/qa/2580/weekly-regression.jpg?raw=true) · [snapshot](https://github.com/Practitionist/familiarise_web/blob/qa-artifacts/qa/2580/weekly-regression.snapshot.txt). |
| 6. Sentry | **PARTIAL — no reported issues, limited telemetry** | Exact-release issue searches returned **no issues**; release metadata reports `newIssues: 0`. `firstEvent` and `lastEvent` are null. No claim of complete error-capture coverage. |

Recorded successful starts (all end one hour later):

| UTC | Asia/Kolkata |
|---|---|
| 2026-11-13 12:30Z | Fri 13 Nov, 18:00 |
| 2026-11-13 18:30Z | Sat 14 Nov, 00:00 |
| 2026-11-14 18:30Z | Sun 15 Nov, 00:00 |

### Findings and copy/polish

1. **P1 — valid multi-day rows disappear from the grid.** The [availability route at this head](https://github.com/Practitionist/familiarise_web/blob/92c62a46cb4afe6c3c7e2fcff55faf495504e14a/app/api/scheduling/availability-with-allocation/%5BconsultantId%5D/route.ts#L962) discards every custom row longer than 24 hours. The allocator successfully uses the same row. This is an existing guard omitted by the fix, not a newly introduced filter. Support valid coalesced spans in the grid and add a route-level regression covering this actual 64-hour row; the grid-alignment unit assertion did not expose it.
2. **P2 — free checkout shows a fictitious ₹1 monthly fee.** The plan persisted at **0**, and subtotal/tax/total show **₹0**, but **Monthly Fee** shows **₹1**. [Source](https://github.com/Practitionist/familiarise_web/blob/92c62a46cb4afe6c3c7e2fcff55faf495504e14a/app/checkout/plans/subscription/%5BplanId%5D/page.tsx#L799) uses `price || 100`. Preserve zero, label the free enrollment clearly, and avoid asking a free buyer to “Pay with Razorpay.” This is pre-existing checkout behavior, outside the allocator diff. [Screenshot](https://github.com/Practitionist/familiarise_web/blob/qa-artifacts/qa/2580/free-checkout-copy.jpg?raw=true).
3. **P2 — irrelevant bank advice on a verification refusal.** The free attempt said **“This subscription isn't available to book until the expert is verified.. Please try again or contact your bank for assistance.”** Verification cannot be fixed by a bank. Show the eligibility refusal directly and remove the doubled punctuation. Also observed raw **GENERAL / BEGINNER**, **“1 months”**, **“1 hour(s)”**, and refund promises on a ₹0 checkout. These are concrete copy problems; AI authorship cannot be inferred. [Snapshot](https://github.com/Practitionist/familiarise_web/blob/qa-artifacts/qa/2580/free-checkout.snapshot.txt).
4. **P3 — mobile refusal suggests an unavailable action.** The shortfall message says “schedule the ones that fit now,” but the mobile view offers no partial-schedule action. Offer it or tell the user the specific next step. The separate “Please access this on desktop for now” copy also sits above a working Auto-schedule button; clarify that only manual time picking needs desktop.

### Cleanup and side effects

- Deleted the fixture appointment and its **three** occurrences after recording the successful allocation; verified no payment was attached before deleting. Negative/horizon attempts created no appointment.
- Deleted the fixture subscription, consultation, both fixture plans, the fixture availability row and the newly created **Scheduling** topic. No money rows were created or changed.
- Restored all **36** original availability rows, including IDs and timestamps. Before/after hash: **`7c805057da0c9d380d123525c9207277`**. `scheduleType=CUSTOM` and `timezone=Asia/Tehran` unchanged.
- Removed the fixture notification-outbox record. It had already reached **SENT**, so one mock-account booking notification may remain in Novu's inbox; database cleanup does not retract that external notification. No failed-email record matched the fixture.
- Final SQL: fixture subscriptions **0**, consultations **0**, plans **0**, windows **0**, appointments **0**, occurrences **0**, topic **0**, outbox **0**. Signed out. Normal authentication/telemetry history may remain.

[All #2580 evidence](https://github.com/Practitionist/familiarise_web/tree/qa-artifacts/qa/2580)
