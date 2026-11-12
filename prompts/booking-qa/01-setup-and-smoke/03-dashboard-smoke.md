# 01-c · Smoke: every dashboard route, every persona

**Needs:** 01-a and 01-b (so lists aren't all empty; F-BUSY gives one real booking). Preview OK.
**Personas:** H1, H2, H3, H4, OX, B1, B2, B3, B4, DR, OS, OH, ST, AD.
**Docs under test:** `_shared/personas-and-fixtures.md` §2, `docs/booking/06-booking-lifecycle.md` ("Times are rendered in the viewer's zone").

How to smoke one route (apply to every route listed below, and report one line per route):

1. `navigate_page`, wait for the skeleton to resolve. Time to usable content (> 3 s is PERF).
2. `list_console_messages`: errors and warnings verbatim (hydration mismatch, React key warnings, failed fetches).
3. `list_network_requests`: any 4xx/5xx you didn't cause; duplicate identical GETs.
4. `take_snapshot` and read the page:
   - no raw enum or code shown to a person: `SCHEDULED`, `APPROVED_PENDING_PAYMENT`, `AWAITING_PAYMENT`, `PENDING`, `IN_PROGRESS`, `COMPLETED`, `CONSULTATION`, snake_case or SCREAMING_CASE anywhere in visible text;
   - no `undefined`, `null`, `NaN`, `Invalid Date`, `₹NaN`, `[object Object]`, empty parentheses, "0 sessions" next to a booked session;
   - every time shows a zone or is clearly in the viewer's profile zone; spot-check F-BUSY's time against its UTC value;
   - empty states say what the list is and what to do next ("No appointments yet" plus a link), not a blank card or a spinner that never ends;
   - copy is plain and specific: flag filler ("Seamlessly manage…", "Unlock…", "Effortlessly…") as AI-SLOP.
5. Keyboard: Tab from the top reaches the main nav and the first primary action with a visible focus ring.
6. One screenshot per route only when something is wrong.

Viewport: 1440×900 for the sweep; repeat S-18 at 390×844 (phone). The full four-viewport sweep is 13-copy-a11y-responsive.

Record a route table in the report: route · persona · verdict · findings.

## S-18 — Consultant routes as H1 (main 1:1 host)

**Why it matters:** H1 is in nearly every journey; a broken nav here blocks half the suite.

**Steps:** sign in as H1 and smoke, in order:

- `/dashboard/consultant/[H1 cid]/home` (Needs-you, today; F-BUSY should appear on Tue D+1 as an upcoming session)
- `…/requests` (empty or only fixtures; tabs including Trials)
- `…/appointments` (F-BUSY listed at Tue D+1 18:00 IST, client B3)
- `…/appointments/[F-BUSY aid]` (detail: time, client, price, actions; no "Join" before the join window)
- `…/appointments/[F-BUSY aid]/timings` and `…/[aid]/reschedule` (grid loads; deep checks in 02)
- `…/availability` (F-AV1 rows)
- `…/offerings/consultation/new`, `…/offerings/subscription/[S-11 id]/edit`
- `…/sell/sessions`, `…/sell/programs`
- `…/earnings` (F-BUSY earning, held, in ₹)
- `…/settings`, `…/settings/booking`, `…/settings/account`
- the rest of the nav: `…/messages`, `…/reviews`, `…/documents`, `…/recordings`, `…/library`, `…/products`, `…/referrals`, `…/collaborations`, `…/support`, `…/support/requests`

Then repeat home, appointments and requests at 390×844.

**Expect:**

- Every route renders for H1 with no console error. F-BUSY shows in the same IST time everywhere it appears. Earnings shows the F-BUSY amount with the platform fee split and a hold date in plain words, not an ISO string.
- At 390×844 the grid pages show the desktop-only notice where documented (allocate, availability); lists stack without horizontal scroll.

**Cross-check:** F-BUSY time on home = appointments list = detail = DB `startsAt` (12:30Z = 18:00 IST).

**Probe further:** does home's "Needs you" explain why it's empty? Does the appointments list say which zone its times are in? Any nav item that 404s or shows a "coming soon" with no explanation?

## S-19 — Consultant routes as H2, H3, H4 and OX

**Why it matters:** group hosts, a New York host, a Kathmandu custom-schedule host and an org-hosted expert each hit different branches.

**Steps:**

1. H2: home, requests, appointments (the two webinars and the class sessions from S-14/S-15), `…/appointments/participants/webinar/[id]`, availability, sell/sessions, sell/programs (draft class shows "Schedule now"), earnings.
2. H3 (America/New_York): home, appointments, availability. Every time on these pages must be New York time.
3. H4 (Asia/Kathmandu, custom schedule): availability (Custom Schedule active, 6 dates), home, appointments.
4. OX: home, offerings list, sell/sessions (the S-16 org-hosted plan; any "managed by LearnPro" note), earnings (how org-hosted earnings are labelled).

**Expect:**

- No route errors for any of them. H3's pages print EST/EDT labels or "New York"; H4's print +05:45 times (e.g. 10:15). H2's class sessions show as a series, not 8 unrelated rows (record how they show).
- OX can't edit the org-governed plan; the page says why (record copy).

**Probe further:** does H3's home "today" use New York's today or IST's today near midnight? (Note the clock time you checked.) For H4, are any times shown at :00/:30 local that would be off-grid? That would be a rendering bug.

## S-20 — Consultee routes as B1, B2, B3 and B4

**Why it matters:** buyers in four zones; the consultee side has its own lists and payment pages.

**Steps:**

1. B3 (America/Los_Angeles, owns F-BUSY): `/dashboard/consultee/[B3 uid]/home`, `…/appointments`, `…/appointments/[F-BUSY aid]`, `…/appointments/[aid]/reschedule`, `…/payments`, `…/payments/[F-BUSY payment id]`, `…/settings`, `…/messages`, `…/library`, `…/referrals`, `…/support`.
2. B1 (IST), B2 (Europe/London), B4 (IST): home, appointments, payments. They have no bookings yet.
3. As B1, open `/explore/experts/[H1 cid]`, `/explore/experts/[H2 cid]`, `/explore/experts/[H3 cid]`, `/explore/experts/[H4 cid]` and one checkout page each for S-08, S-11, S-14a, S-15a (`/checkout/plans/{consultation,subscription,webinar,class}/[planId]`). Don't pay.

**Expect:**

- B3 sees F-BUSY at Tue D+1 04:30 PST (or 05:30 PDT if before 1 Nov), the ₹ amount on payments, and a receipt link or detail page that loads.
- B1/B2/B4 empty states point to Explore.
- Explore and checkout pages load with no console errors; checkout summaries show time in the buyer's zone and the price in ₹.

**Cross-check:** F-BUSY on B3's pages vs H1's pages (S-18): same instant, two zones.

**Probe further:** does B3's reschedule page explain the 24-hour rule before B3 picks anything? Does the payments page explain "held" vs "paid"? Any checkout that shows a ₹0 payment button for a free plan?

## S-21 — Dual role (DR) and org members (B4 learner)

**Why it matters:** DR is a Wipro learner and possibly a consultant; role switching and org tags change which lists show what.

**Steps:**

1. As DR (Australia/Sydney): open `/dashboard`. Record where it lands. If DR has both roles, switch roles with the app's role switcher and open each home.
2. DR consultee: home, appointments, payments. DR org: `/dashboard/organization/[Wipro]/my-program` (or wherever the learner view lives).
3. As B4: `/dashboard/organization/[Wipro]/my-program` and the consultee home. Note any "sponsored by Wipro" wording.

**Expect:** every page loads; times for DR are Sydney (AEDT in November); no page shows another learner's data.

**Probe further:** if DR is not dual-role per S-01, say so and mark the dual-role half BLOCKED. Does the role switcher keep the same URL family or dump you on a generic home?

## S-22 — Org dashboards: OS (Wipro sponsor) and OH (LearnPro host)

**Why it matters:** org-funded and org-hosted journeys in 03 report to these pages.

**Steps:**

1. As OS: `/dashboard/organization/[Wipro]/home`, `…/appointments`, `…/requests`, `…/members`, `…/billing`, `…/programs`, `…/analytics`, `…/audit`, `…/my-program`.
2. As OH: `/dashboard/organization/[LearnPro]/home`, `…/appointments`, `…/catalog`, `…/compensation`, `…/payouts`, `…/collaborations`, `…/members`.
3. If either owner has an org workspace, open `/dashboard/org-workspace/[id]/home` and `…/activity`.

**Expect:**

- All load. Lists are metadata only (an org sees that a session happened, never its content).
- OH catalog lists LearnPro's webinars/classes; note whether S-16's consultation appears.
- No org page shows F-BUSY (it's personal, card-paid, on H1's personal plan).

**Probe further:** any "Everyone" feed that shows a member's personal card purchase is a SECURITY finding (doctrine §4). Wording of empty states ("No sponsored sessions yet").

## S-23 — Staff back office (ST)

**Why it matters:** staff resolve stuck work and refunds; their console must find any booking from the suite.

**Steps:**

1. Sign in as ST (`SEED_OPERATOR_PASSWORD`). If an operator-consent dialog appears on first sign-in, read it and accept.
2. Open `/dashboard/staff/home`, then `…/appointments` (search for F-BUSY by id or client), `…/stuck-work`, `…/money`, `…/payments/[F-BUSY payment id]`, `…/subscriptions`, `…/support`, `…/users/[B3 userId]`, `…/trace`, `…/system-jobs`.
3. Open `/dashboard/admin/home` as ST.

**Expect:**

- Staff routes load. F-BUSY is findable and shows the same UTC instant (staff pages may render in UTC or a fixed zone; record which and whether it's labelled).
- Step 3: ST is redirected to the staff twin of the page (`/dashboard/staff/home`), not shown an error.

**Cross-check:** F-BUSY's status on staff appointments = H1's and B3's dashboards.

**Probe further:** `_shared/personas-and-fixtures.md` §2 lists the staff route as `/dashboard/staff/[staffProfileId]/…`; the code uses the literal tree segment `/dashboard/staff/…` (`lib/backoffice/capability.ts`, trees `admin` and `staff`). Report it as DOC-DRIFT. Does `/dashboard/anything-else/home` 404?

## S-24 — Admin (AD): landing, maintenance, system jobs

**Why it matters:** maintenance mode freezes booking writes (11 tests it); system jobs is where sweeps are inspected (12).

**Steps:**

1. Sign in as AD. Open `/dashboard/admin/home`, `…/maintenance`, `…/system-jobs`, `…/analytics`, `…/metrics`, `…/money`.
2. On system jobs, read the job list and each job's last-run time. Don't click Run. If you do by mistake off production, expect 409 `JOB_RUN_PRODUCTION_ONLY`.
3. On maintenance, read the current state. Don't toggle it.

**Expect:** pages load; maintenance shows off; the jobs page names the sweeps used later (`expire-stale-requests`, `abandoned-payments`, `expire-unpaid-trials`, `auto-complete-appointments`, `retry-auto-refunds`, `settle-cancelled-sessions`). Record any missing.

**Probe further:** do job descriptions say what each one does in plain words? Is a "last run" time zone labelled?

## S-25 — Wrong-persona URLs land somewhere sane

**Why it matters:** a smoke-level authz check; the full matrix is 09-concurrency-integrity.

**Steps:**

1. As B1 open `/dashboard/consultant/[H1 cid]/home` and `/dashboard/consultee/[B3 uid]/appointments/[F-BUSY aid]`.
2. As H2 open `/dashboard/consultant/[H1 cid]/appointments/[F-BUSY aid]`.
3. Signed out, open `/dashboard/consultee/[B3 uid]/home`.

**Expect:** steps 1–2 redirect to the viewer's own dashboard or show a 404/"not found"; never H1's or B3's data. Step 3 sends you to `/auth/signin` and back after sign-in.

**Probe further:** does any of these leak a name, time or price in the HTML before redirect (view the network response body)? That's SECURITY P0.
