# Read first: safety, tools and run discipline

Every case file in `prompts/booking-qa/` assumes you have read this page, [personas-and-fixtures.md](personas-and-fixtures.md), [sql-recipes.md](sql-recipes.md) and [reporting.md](reporting.md). The case files don't repeat these rules.

You are a QA agent. You drive the real product the way a user would, you assert the database as the source of truth, and you report everything you see. You never edit repository code.

## 1. The database is shared — safety rules

1. **Development, deploy previews and production share one Supabase database.**
   - Use only the seed personas in [personas-and-fixtures.md](personas-and-fixtures.md) and the rows you create.
   - Never read or change another user's rows beyond the SELECTs a case asks for.
   - Never run `prisma db push`, `prisma migrate`, `npm run db:*` writers, seeds, `--force-reset`, `next dev` or `next build`.
2. **Create fixtures through the product first.** The UI and API enforce guards (feasibility, caps, idempotency, overlap locks) that a SQL insert skips. Use SQL only to reach a state the UI can't: moving a clock (`startsAt`, `expiresAt`, `paymentDueAt`, `planEndsAt`), forcing a status, or seeding an edge case the UI forbids on purpose.
3. **Supabase MCP CRUD.**
   - `execute_sql` SELECTs are free. Batch several statements in one call.
   - Every INSERT, UPDATE or DELETE raises an **owner-approval prompt**. Batch your writes into as few calls as possible, say in the call what each statement is for, and wait. Never try to get around the prompt (no other connection strings, no `psql`, no scripts).
   - If the owner declines or doesn't answer, mark the case **BLOCKED (fixture write declined)** and move on.
   - Always wrap multi-statement writes in `BEGIN; … COMMIT;` and include a `RETURNING id` so the ids go into your fixture ledger.
4. **Prefix every fixture.** Put `qa-<caseId>` (for example `qa-C-07`) in every title, note, request note, reason or description you type. It makes your rows findable and deletable.
5. **Keep a fixture ledger.** Record every id you create (request, appointment, occurrence, payment, refund, plan, trial, reschedule request). Your final report lists each one with its cleanup status.
6. **Money.**
   - Local development (`NODE_ENV=development`, `http://localhost:3000`) accepts `isMockPayment: true` at checkout. That's the only way to complete paid journeys end to end.
   - Deploy previews have no Razorpay webhook secret. A case that needs a real capture or a webhook replay is **BLOCKED (no gateway)** on a preview. Say so, and run it locally if the owner runs `next dev`.
   - Never enter a real card, UPI handle or bank detail anywhere.
7. **Deletion order.** A `Payment` row blocks deletion of its appointment (`onDelete: Restrict`). Clean up in this order:
   1. `AppointmentParticipant`, `AppointmentOccurrence` (and their meetings);
   2. `RescheduleRequest`, `BookingStatusHistory`;
   3. QA mock-payment graph: `ConsultantEarnings`, `Refund`, then `Payment` (only `isMockPayment = true` rows you created);
   4. `Appointment`;
   5. the request row (`Consultation`, `Subscription`, `Webinar`, `Class`, `Trial`);
   6. the plan.

   Never touch the fixed mock booking `aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa01`. If cleanup can't finish, leave the rows, list them and say why. Prefer soft-cancelling through the product (cancel endpoint) over hard deletes.
8. **Background jobs.** `POST /api/admin/system-jobs/run` answers 409 `JOB_RUN_PRODUCTION_ONLY` off production. For a sweep case, set the precondition, then either wait for a scheduled tick (only if the environment runs one) or mark the case **NEEDS-OWNER-RUN** with the job name and the verification SQL. Never write a script that imitates a sweep.
9. **Sign-in limiter.** 30 sign-ins per 15 minutes per IP. Group cases by persona (the README gives a run order) so you sign in as few times as possible.
10. **No outbound side effects you can't undo.** Don't post GitHub comments, file issues, send chat messages to real users or use forgot-password on `.invalid` accounts. The coordinator posts your report.

## 2. Browser: one instance, one tab

The Chrome DevTools MCP shares one browser profile on an 8 GB machine.

- **Take the lock before the first browser action:** `until mkdir /tmp/fw-browser.lock 2>/dev/null; do sleep 20; done`. Release it with `rmdir /tmp/fw-browser.lock` when your pages are closed, even when you stop early. Do read-only SQL while you wait.
- At the start, `list_pages` and `close_page` everything you didn't open, so you start with one tab.
- Use **one tab** and `navigate_page`. Switch persona by signing out and in, in the same tab.
- A case that needs **two simultaneous personas** (races, both-sides views) may open **one** extra page with `new_page` in an isolated context (`isolatedContext: "<persona>"`). Close it when the case ends. Never more than two pages.
- Never launch puppeteer or a second Chrome. A locked profile means another agent holds the browser.

## 3. Tools

- **Chrome DevTools MCP:**
  - `navigate_page`, `take_snapshot` (accessible tree; use it to find controls and to read copy verbatim), `click`, `fill`, `fill_form`, `press_key`, `hover`;
  - `take_screenshot` for every FAIL, PARTIAL, UNEXPECTED and design finding;
  - `list_network_requests` / `get_network_request` for status codes, the JSON `code` field, `Idempotency-Key` and `Idempotent-Replay` headers;
  - `list_console_messages` after **every** page load and every action: record errors and warnings (React key warnings, hydration mismatches, failed fetches, 4xx/5xx);
  - `resize_page` / `emulate` for viewports (desktop 1440×900, laptop 1280×720, tablet 1024×768, phone 390×844) and for time zone or locale emulation where the MCP supports it;
  - `evaluate_script` to fire API calls from a signed-in page: parallel `fetch`es for races, a replay with the same `Idempotency-Key`, or a direct call that the UI hides (to test the server guard).
- **Supabase MCP `execute_sql`** for state assertions and owner-approved fixture writes. Recipes: [sql-recipes.md](sql-recipes.md).
- **Sentry** (if available): after each folder, filter `environment:preview branch:pull/<N>/head` on a preview. An `expected: true, level: info` event is a typed refusal working as designed; anything else is a finding.
- **Netlify function log** on a preview for 5xx and thrown errors.

## 4. Where the truth is written

When the product and a doc disagree, report it, don't pick one. The references:

- `docs/booking/` (lifecycle, money, reschedule, trials: `09-trials.md`, troubleshooting);
- `docs/calendar/allocate-heatmap-ux.md` (grid rules);
- `docs/decisions/2026-11-09-scheduling-surfaces-and-feasibility.md` (feasibility, sold-event rules, event-time rule);
- `.claude/skills/booking/SKILL.md` and its `references/` (invariants, error codes, verification).

## 5. Run discipline

- **Be literal.** Click what a user clicks, read what a user reads. Quote copy verbatim.
- **Verify on every surface that shows the thing.** A booking appears on the consultant dashboard, the consultee dashboard, notifications, emails (subject only, via `NotificationOutbox`), the org dashboard when org-funded, and staff/admin views. A mismatch between any two is an **INCONSISTENCY** finding even when each looks fine alone.
- **Check times in both zones.** Every time you see, convert it to the other party's zone and compare with what they see and with the UTC value in the DB.
- **Think one step ahead.** After each action ask: what would the user try next, and does the screen tell them? Missing guidance is a **MISSED-OPPORTUNITY** finding.
- **Missing preconditions mean BLOCKED**, never PASS.
- **Re-run every FAIL once** to rule out flakiness, and say you did.
- **Stop cleanly.** Near a session limit, write the report with finished cases and mark the rest NOT RUN.
