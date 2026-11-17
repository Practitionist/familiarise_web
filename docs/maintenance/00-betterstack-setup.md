# BetterStack Setup Guide

> **Start here.** This is the first thing a new developer should set up. Without BetterStack configured, the maintenance system cannot auto-create or resolve incidents, and `/api/health` will return `betterstack.configured: false`.

This guide walks through setting up BetterStack from scratch for the Familiarise platform — creating an account, configuring monitors, building the status page, generating an API token, and adding it to the environment. Every step is described at the level of detail needed for someone who has never touched BetterStack before.

---

## What BetterStack Does for Familiarise

BetterStack provides two things:

1. **Uptime monitoring**: Checks `familiarisenow.com` and `familiarisenow.com/api/health` every 3 minutes from multiple global regions. Sends email alerts if either goes down.
2. **Incident management**: When the platform enters OFFLINE maintenance mode, `lib/betterstack.ts` automatically creates a BetterStack incident. When maintenance ends, it auto-resolves the incident. This keeps the public status page in sync with actual platform state.

**Free plan limitations** (important to know):

- Minimum check frequency: 3 minutes (paid plans go down to 30 seconds)
- Alert methods: email only (push/SMS/call require paid plan at $29/month)
- Escalation policies: paid only
- Status pages: 1 free, additional are billable
- Logs (Telemetry): 3-day retention on the free plan

The owner decided on 2026-11-01 to stay on the free plan until launch, alerting by email and Slack, and to buy the responder seat (phone and SMS) and the Telemetry Nano bundle (30-day retention, EU) at launch; see [the decision](../decisions/2026-11-01-observability-gaps-and-launch-posture.md) and the [money go-live checklist](../finance/70-operations/07-go-live-checklist.md).

---

## Account Setup

### Step 1: Create an account

1. Go to [https://uptime.betterstack.com/users/sign-up](https://uptime.betterstack.com/users/sign-up)
2. Enter your email address — BetterStack uses **magic links**, not passwords
3. Click **"Send magic link"**
4. Open your email inbox and click the magic link — it signs you in directly
5. Complete any onboarding prompts (team name, etc.)

> **Existing account**: The Familiarise account is under `teetangh@gmail.com`. To regain access, go to the sign-in page and request a new magic link to that email.

---

## Phase 1: Create Monitors

Monitors check your URLs on a schedule and alert you when they go down.

### Step 2: Create the Website monitor

1. In the left sidebar, click **"Monitors"**
2. Click **"Create monitor"** (top right)
3. Fill in the form:
   - **URL to monitor**: `https://familiarisenow.com`
   - **Monitor type**: HTTP (default)
   - **Check frequency**: `3 minutes` (lowest on free plan)
   - **Confirmation period**: `30 seconds` (waits 30s before alerting, reduces false positives)
   - **Alert via**: Email — select the team email
   - **Regions**: Leave at default (all available regions)
4. Scroll down and click **"Create monitor"**
5. You'll see "Monitor was successfully created" and the monitor will show status **"Pending"** while the first check runs

### Step 3: Create the API Health monitor

1. Click **"Create monitor"** again
2. Fill in the form:
   - **URL to monitor**: `https://familiarisenow.com/api/health`
   - **Monitor type**: HTTP
   - **Check frequency**: `3 minutes`
   - **Request timeout**: `60 seconds` (Advanced settings — NOT the 30s default)
   - **Confirmation period**: `1 minute` (Advanced settings — NOT the 30s default)
   - **Alert via**: Email
3. Click **"Create monitor"**

> **Why 60s / 1 minute on this monitor (#1557).** This route runs in the
> Next.js server handler, and a brand-new instance of that handler blocks its
> event loop for 24–39 s before doing any work (#1124, platform-side, open).
> At the 30 s default, ~8 checks a day landed on such an instance, timed out,
> and the confirmation re-checks from two more regions — arriving concurrently
> a few seconds later — each spawned another stalled instance and confirmed a
> "down" that never was: 100 false incidents in the 30 days to 2026-09-11,
> every one on the public status page. A 60 s timeout lets the stall pass; a
> real outage still pages within ~2 minutes. The stall itself stays visible in
> the response-time graph and in the payload's `platform.eventLoopStallMs`.

After a few minutes, both monitors should show **"Up"** status. The monitors page will show:

```
familiarisenow.com/api/health    Up · 3m
familiarisenow.com               Up · 3m  · Used on 1 status page
```

---

## Phase 2: Create Status Page

The status page at `familiarise.betteruptime.com` is a public page showing system health. It auto-reflects incidents created by the maintenance system.

### Step 4: Navigate to Status Pages

1. In the left sidebar, click **"Status pages"**
2. Click **"Create status page"**

### Step 5: Fill in the status page form

On the **Settings** tab:

- **Company name**: `Familiarise`
- **Subdomain**: `familiarise` → this creates `familiarise.betteruptime.com`
- **What URL should your logo point to?**: `https://familiarisenow.com`
- **Get in touch URL**: `mailto:connect@practitionist.com` (`SUPPORT_EMAIL`)
- **Status page design**: `Modern look` (default)
- **Color theme**: `Light version` (default)

Leave everything else at default. Click **"Save changes"**.

You'll see "Status page was successfully created" and land on the **Structure** tab.

### Step 6: Add monitors to the status page

> **Note**: The BetterStack UI has a known issue where the monitor search dropdown sometimes shows an empty list. The workaround below adds monitors directly via JavaScript form injection.

The status page structure uses a standard HTML form. To add both monitors:

**Add Website monitor (already added by default):**
BetterStack auto-adds the first monitor when creating the status page. You'll see it listed as `familiarisenow.com`.

**Rename it to "Website":**

1. In the structure tab, find the resource card for `familiarisenow.com`
2. Look for a "Public name" field — change it from `familiarisenow.com` to `Website`

**Add API Health monitor (requires form injection if UI dropdown is broken):**

Open your browser developer tools console (F12 → Console) while on the Structure page, and run:

```javascript
const form = document.querySelector('form[id^="edit_status_page"]');
const sectionKey = "1";
const newKey = "new_4093822"; // Use the monitor ID from the monitors page URL
const fields = [
  ["resource_id", "4093822"], // Monitor ID from monitors page URL
  ["resource_type", "Endpoint"],
  ["resource_index", "1"],
  ["_destroy", "0"],
  ["public_name", "API Health"],
  ["explanation", ""],
  ["widget_type", "history"],
  ["mark_as_down_for", "any_incident"],
  ["mark_as_degraded_for", "no_incident"],
];
fields.forEach(([key, value]) => {
  const input = document.createElement("input");
  input.type = "hidden";
  input.name = `status_page[status_page_sections_attributes][${sectionKey}][status_page_resources_attributes][${newKey}][${key}]`;
  input.value = value;
  form.appendChild(input);
});
form.submit();
```

> **How to find the monitor ID**: Go to the Monitors page and click on `familiarisenow.com/api/health`. The URL will be `https://uptime.betterstack.com/team/t332379/monitors/4093822` — the number at the end is the monitor ID.

After submission, the page refreshes and you'll see:

- `Website` — With status history
- `API Health` — With status history

**Current status page**: [https://familiarise.betteruptime.com](https://familiarise.betteruptime.com)

---

## Phase 3: Generate API Token

The API token allows `lib/betterstack.ts` to create and resolve incidents programmatically.

### Step 7: Create the API token

1. Click your avatar/profile icon (top right) → **"Settings"**, or navigate directly to [https://betterstack.com/settings/account](https://betterstack.com/settings/account)
2. In the left sidebar under **Organization**, click **"API tokens"**
3. Under **Global API tokens**, enter a token name: `Familiarise Production`
4. Click **"Create"**
5. The token appears immediately — **copy it now**. It will not be shown again after you navigate away.

> The token is a 24-character string, e.g. `TP1gbvr2sCtjaWWPovb8s2fM`.

---

## Phase 4: Add to Environment

### Step 8: Add to local .env

Add the following line to `.env` in the project root:

```env
# BetterStack uptime monitoring & incident management
BETTERSTACK_API_KEY="<your-token-here>"
```

### Step 9: Add to Netlify (production)

1. Go to your Netlify team dashboard → select the Familiarise site
2. Navigate to **Site configuration → Environment variables**
3. Click **"Add a variable"**
4. Key: `BETTERSTACK_API_KEY`
5. Value: `<your-token>`
6. Scope: All scopes (or at minimum: Production)
7. Click **"Save"**
8. Trigger a redeploy for the variable to take effect

---

## Phase 5: Verify It Works

### Step 10: Test via /api/health

The `/api/health` endpoint calls the BetterStack API and returns monitor statuses:

```bash
curl https://familiarisenow.com/api/health
```

Expected response:

```json
{
  "status": "healthy",
  "database": "connected",
  "platform": {
    "eventLoopStallMs": 1,
    "processUptimeMs": 184203,
    "databaseLatencyMs": 41,
    "databaseProbeRetried": false
  },
  "maintenance": { "phase": "OFF", "reason": null, "estimatedEnd": null },
  "betterstack": {
    "configured": true,
    "reachable": true,
    "monitors": [
      { "name": "https://familiarisenow.com", "status": "up" },
      { "name": "https://familiarisenow.com/api/health", "status": "up" }
    ]
  },
  "timestamp": "2026-02-22T10:00:00.000Z"
}
```

If `betterstack.configured` is `false`, the `BETTERSTACK_API_KEY` env var is missing.
If `betterstack.reachable` is `false`, the API key is wrong or BetterStack is unreachable.

`platform` reports the instance the check landed on, not a dependency, and never
changes `status`. `eventLoopStallMs` is 0–2 on a warm instance and 24 000–39 000
on a brand-new one under concurrent creation (#1124); a value over 1 s is also
logged to Sentry as `Cold-instance event-loop stall`, so the stall's frequency is
queryable. `databaseProbeRetried` is true when the first probe's deadline fired
during such a stall and the route re-probed — the retry is what keeps a cold
instance from reporting the database `unreachable` (#1557).

### Step 11: Test via direct API call

```bash
curl -sS "https://uptime.betterstack.com/api/v2/monitors" \
  -H "Authorization: Bearer $BETTERSTACK_API_KEY" \
  | jq '[.data[] | {id, name: .attributes.pronounceable_name, url: .attributes.url, status: .attributes.status, paused: .attributes.paused}]'
```

Should return both monitors with their status. Keep the `jq` filter: the raw response includes each monitor's `request_headers`, which hold the bearer `CRON_SECRET`.

### Step 12: Test incident lifecycle (optional but recommended)

This tests the full OFFLINE → incident created → maintenance ended → incident resolved flow:

1. Log into the admin dashboard and activate **OFFLINE** maintenance mode
2. Check `POST /api/admin/maintenance` returns `betterstackIncidentId` in the response
3. Go to [https://uptime.betterstack.com/team/t332379/incidents](https://uptime.betterstack.com/team/t332379/incidents)
4. Verify a new incident was created automatically
5. End maintenance mode via the admin dashboard
6. Return to BetterStack incidents — the incident should show as "Resolved"

---

## Account Details (Current Setup)

| Item                   | Value                                                                             |
| ---------------------- | --------------------------------------------------------------------------------- |
| **BetterStack URL**    | https://uptime.betterstack.com/team/t332379                                       |
| **Email**              | teetangh@gmail.com                                                                |
| **Plan**               | Free                                                                              |
| **Monitor 1**          | `https://familiarisenow.com` (public: "Website")                                  |
| **Monitor 2**          | `https://familiarisenow.com/api/health` (public: "API Health")                    |
| **Monitor 3**          | `familiarise job fleet probe (prod)` (5189236), on `/api/health/jobs`             |
| **Heartbeats**         | `familiarise cron-tick (prod)` (521597), `familiarise ops digest (prod)` (523773) |
| **Check frequency**    | 3 minutes (free plan minimum) for monitors 1 and 2; 5 minutes for monitor 3       |
| **API Health timeout** | 60 s request timeout, 1 min confirmation (see Step 3, #1557)                      |
| **Alert type**         | Email only (push/SMS require paid plan)                                           |
| **Status page**        | https://familiarise.betteruptime.com                                              |
| **API token name**     | "Familiarise Production"                                                          |
| **API base URL**       | `https://uptime.betterstack.com/api/v2`                                           |

---

## Code Integration Summary

The BetterStack integration lives in two files:

### `lib/betterstack.ts`

Exports two functions:

- `createIncident(name, summary?)` — Creates a BetterStack incident. Returns the incident ID (`string | null`).
- `resolveIncident(incidentId)` — Resolves an incident by ID. Returns `boolean`.

Both functions fail gracefully: if `BETTERSTACK_API_KEY` is missing or the API call fails, maintenance mode still activates (fail-open design).

### `app/api/admin/maintenance/route.ts`

- **POST** (start maintenance): If phase is `OFFLINE`, calls `createIncident()`. Stores the returned `incidentId` in Redis as part of the maintenance config JSON (`maintenance:config`).
- **DELETE** (end maintenance): Reads `betterstackIncidentId` from the current state and calls `resolveIncident()`.
- **GET** (read state and history): the route is gated on the matrix key `maintenance.manage` (ADMIN only) through `requireBackofficeSurface`. `state` is the active window, so it carries the active window's `bypassSecret` and `betterstackIncidentId` (the controls panel needs both), with a signed `bypassCookieToken`. `history` is the last 20 platform windows through an explicit `select` (`historySelect`) that leaves out `bypassSecret` and `betterstackIncidentId`, so an ended window's secret never leaves the server. A window that is still active appears in `history` without its secret too. The shape:

```json
{
  "state": {
    "phase": "OFFLINE",
    "reason": "Database upgrade",
    "estimatedEnd": "2026-12-01T22:30:00.000Z",
    "bypassSecret": "...",
    "betterstackIncidentId": "12345",
    "offlineActivatedAt": "2026-12-01T20:05:00.000Z",
    "bypassCookieToken": "..."
  },
  "bypassCookieToken": "...",
  "history": [
    {
      "id": "...",
      "phase": "OFFLINE",
      "reason": "Database upgrade",
      "scheduledAt": null,
      "startedAt": "2026-12-01T20:00:00.000Z",
      "endedAt": null,
      "estimatedEnd": "2026-12-01T22:30:00.000Z",
      "startedBy": "...",
      "endedBy": null,
      "offlineActivatedAt": "2026-12-01T20:05:00.000Z",
      "createdAt": "2026-12-01T20:00:00.000Z",
      "updatedAt": "2026-12-01T20:05:00.000Z"
    }
  ]
}
```

Every mutation of the route passes the signed-in operator as the required `actor` of `setMaintenanceState`, so its `maintenance.transition` audit row names the real role. The OFFLINE setup step also writes a `maintenance.offline-activated` row, once per activation, in the same transaction that stamps `offlineActivatedAt`.

### `lib/maintenance.ts`

`MaintenanceState` interface includes `betterstackIncidentId: string | null`. The Redis config JSON (`maintenance:config`) includes it:

```json
{
  "reason": "...",
  "estimatedEnd": "...",
  "bypassSecret": "...",
  "betterstackIncidentId": "12345"
}
```

### `app/api/health/route.ts`

Calls `GET https://uptime.betterstack.com/api/v2/monitors` on every health check request (5-second timeout). Returns:

```typescript
{
  configured: boolean,   // BETTERSTACK_API_KEY is set
  reachable: boolean,    // API call succeeded
  monitors: Array<{ name: string, status: string }>
}
```

---

## Troubleshooting

### "betterstack.configured: false" in /api/health

The `BETTERSTACK_API_KEY` env var is not set. Check:

- Local: Is it in `.env`?
- Production: Is it in Netlify environment variables? Was the site redeployed after adding it?

### "betterstack.reachable: false" in /api/health

The API key exists but the call failed. Check:

- Is the token correct? Verify it in BetterStack Settings → API tokens
- Did the token get accidentally deleted? Generate a new one and update `.env` + Netlify.

### Incident not created when entering OFFLINE mode

1. Check server logs for `[BetterStack] API error:` or `[BetterStack] Failed to create incident:`
2. Verify `BETTERSTACK_API_KEY` is set in production
3. Check BetterStack rate limits (unlikely on free plan)
4. The maintenance mode still activates even if incident creation fails — only the BetterStack sync is affected

### Incident not resolved when ending maintenance

1. Check if `betterstackIncidentId` was stored. The POST response to `/api/admin/maintenance` includes it.
2. If null, incident creation failed when maintenance started. Resolve manually in BetterStack.
3. Manual resolution: BetterStack dashboard → Incidents → find the incident → click "Resolve"

### Status page not showing incident

BetterStack incidents automatically appear on the status page linked to your account. No manual configuration needed. If the incident was created but not showing, wait 1-2 minutes for propagation.

## Independent capability freshness probe

`GET /api/health/jobs` (`app/api/health/jobs/route.ts`) answers one question: did every ticker job that matters run recently enough? It is read-only and uncached. It never invokes, repairs or writes anything. It returns 401 before querying when the bearer is wrong; 503 when a `paging` job is overdue, when the history cannot be read, or when the newest daily digest found a page-worthy verdict (see [Digest verdicts on the probe](#digest-verdicts-on-the-probe)); and 200 otherwise. The body's `reasons` names each cause (`JOB_OVERDUE`, `STANDING_CONFIG_SKIP`, `RELEASE_LAG_OVERDUE`) and `buildSha` names the deployed commit. Because of the 503, a plain uptime monitor can alert on the status code alone.

### Where the budgets come from

The budgets are derived from the schedule, not listed by hand. `OPERATIONAL_COMPLETION_REQUIREMENTS` in `lib/cron/operational-health.ts` holds one requirement for every target in `TARGETS` (`lib/cron/schedule.ts`); every target's core writes a run row. Adding a ticker target therefore adds its absence check in the same change, and renaming a job's run row through `jobNameFor` moves the check with it.

Each budget is computed from the target's longest gap between two consecutive due slots (`maxSlotGapMinutes` in `lib/cron/schedule.ts`):

```text
maxAge = gap + min(gap, 6 h) + 30 min
```

The second term tolerates one missed slot, but never more than six hours of one. The 30 minutes cover a late tick, a background job finishing after its slot and the run's own duration. For a windowed job the gap runs from the last slot of one window to the first slot of the next, so a monthly or quarterly job gets its real calendar gap rather than twice its hourly interval. Worked examples:

| Target                           | Schedule                                              | Longest gap                  | Budget                       |
| -------------------------------- | ----------------------------------------------------- | ---------------------------- | ---------------------------- |
| `appointment-reminders`          | every 15 min                                          | 15 min                       | 15 + 15 + 30 = 60 min        |
| `auth-tokens`                    | once a day at 03:00 UTC                               | 24 h                         | 24 h + 6 h + 30 min = 30.5 h |
| `generate-subscription-invoices` | hourly from 03:05 to 19:05 UTC                        | 8 h                          | 8 h + 6 h + 30 min = 14.5 h  |
| `create-payout-batch`            | every 15 min, Mondays 20:05 to 22:50 UTC              | 6 d 21 h 15 min              | 7 d 3 h 45 min               |
| `settle-invoice-accruals`        | hourly on the 1st, 04:45 to 19:45 UTC                 | 30 d 9 h (the longest month) | 30 d 15 h 30 min             |
| `tds-return-draft`               | hourly 01:55 and 02:55 UTC on 5 Jan, Apr, Jul and Oct | 91 d 23 h (5 Jul to 5 Oct)   | 92 d 5 h 30 min              |

The generated [cron jobs reference](04-cron-jobs-reference.md) prints every target's budget and tier on its "Freshness" line. The shortest budget is 50 minutes (the 10-minute outbox and export drains) and the longest is the quarterly TDS draft.

Every target is judged, including `sentry-ingest-canary` and `stream-control-plane-drift`, which take a fail-open lease so each run writes a row. An unhealthy canary verdict is a 207 `attention` run, which counts as having run, so a Sentry outage stays on the canary's own email and the probe pages only when the canary stops running. `checkJobCoverage` (`lib/cron/job-coverage.ts`) proves at the start of every `npm run build` that each target has exactly one requirement under its live run-row name, so a rename or a dropped target fails the deploy even when GitHub Actions is not running.

### Tiers

A small explicit set in `lib/cron/operational-health.ts` (`WATCHED_TARGETS`) names the housekeeping targets: the job-history and event pruning, audit-log pruning, webhook-event archiving, onboarding-draft and collaborator-invite expiry, unverified-user purge, verification sweep, document and digital-product storage reconciles, and the admin run-request backstop. A late run of one of those only delays cleanup, so it is `watched`: the System Jobs console shows it red, and the probe neither lists it nor fails on it. Every other target is money, compliance or user-facing and is `paging`, so a new target pages by default until someone deliberately demotes it.

### What counts as having run

The probe reads, for each paging job and only as far back as that job's own budget, the newest of these in the serving environment:

- a `COMPLETED` row, or a `FAILED` row whose outcome is `partial` (the run reached its end with some items failing);
- an idle skip on a tick claim row (`lib/cron/idle-skips.ts`), because the probe found no work;
- a config skip (a `CANCELLED` row with outcome `skipped` and a reason ending " not configured"). The job was scheduled and reached, and only a setting is missing; the missing setting is a configuration finding, not an absence. Each job row carries `lastConfigSkipAt`, and `configSkips` lists the last day's reasons.

A `RUNNING` attempt, a held or refused run, a plain `FAILED` run and the shared heartbeat do not count. The probe uses `endedAt` and the job's actual run-row name, so `reconcile-refunds` is judged as `reconcile-pending-refunds` and `appointment-reminders` as `send-appointment-reminders`.

### Runbook: create the Better Stack monitor (owner step, done 2026-11-05)

**Done on 2026-11-05 as monitor `familiarise job fleet probe (prod)` (5189236):** status type, GET, bearer `CRON_SECRET` header, every 5 minutes, 60 s timeout, 1 minute confirmation, e-mail only (phone and SMS arrive with the responder seat at launch). It was created through the Better Stack API, not the dashboard (see [the decision](../decisions/2026-11-05-detector-rollout-and-redundancy.md)). The steps below remain the manual equivalent.

The owner creates this monitor; the code never creates vendor monitors. It is the external dead-man's switch: it fires when a job goes stale, when the ticker stops, when a deploy breaks the route and when the app is down, even if Sentry and Netlify are quiet.

1. Better Stack → Uptime → **Create monitor**.
2. **URL to monitor:** `https://familiarisenow.com/api/health/jobs`. **Monitor type:** HTTP, alert when the URL becomes unavailable (any non-2xx status).
3. **Request headers:** `Authorization: Bearer <CRON_SECRET>`, using the production value. Never put the secret in the URL.
4. **Check frequency:** 5 minutes. **Request timeout:** 60 seconds and **confirmation period:** 1 minute, for the cold-start stall explained under Step 3 above.
5. Optional belt to the status code: add the keyword check "alert when the response contains" `"healthy":false`.
6. **Alert via:** email (and Slack) on the free plan; add phone and SMS when the responder seat is bought at launch.
7. Do not add this monitor to the public status page: its body names internal jobs.
8. Verify: the monitor shows Up with 200. Then read the body and confirm `healthy: true`. A job listed `overdue` with `lastCompletedAt: null` has no production-tagged run inside its budget; either wait for its next slot or run it once from the System Jobs page (`Run now` records a production run).

During an approved maintenance window, pause the monitor or use Better Stack's maintenance window; do not turn a blocked completion into success. As prior successes age out the probe returns 503 even during maintenance, by design.

The shared database also holds preview and development runs. The probe counts only rows whose `result.environment` matches the serving deployment's `NEXT_PUBLIC_SENTRY_ENVIRONMENT` (or `SENTRY_ENVIRONMENT`); an unset label returns 503 `JOB_ENVIRONMENT_UNCONFIGURED`, and an explicitly empty public label fails instead of falling back. Untagged historical rows never establish production freshness.

What the probe does not prove: that a run's vendor effects are correct, that a backlog is draining (the oldest-pending-age alerts below cover that), or that the alert reaches a human (prove that once with a controlled failure). See [Better Stack HTTP monitor configuration](https://betterstack.com/docs/uptime/api/create-a-new-monitor/) for protected request headers and expected-status monitoring.

### Digest verdicts on the probe

Two verdicts come from the daily ops digest rather than from the probe's own reads. The probe reads the newest `COMPLETED` production `ops-digest` run row (one indexed read) and judges its stored summary at poll time, so a poll never calls GitHub or recomputes skip streaks:

- **`RELEASE_LAG_OVERDUE`** when the digest's `releaseLag.overdue` is true: an unreleased change to `lib/cron/schedule.ts` or `lib/cron/cleanup-registry.ts` is more than 3 days old, any unreleased commit on `dev` is more than 7 days old, or GitHub cut the commit list. An unknown release lag never pages.
- **`STANDING_CONFIG_SKIP`** only when Razorpay collection keys are live (`RAZORPAY_KEY_ID` starts with `rzp_live_`) and a paging job has skipped for a missing setting for more than 7 days, counted from the first skip after its last real run. Before live keys this is a digest line only.

After fixing the cause, run `ops-digest` once from the System Jobs page; the next probe poll reads the new row and answers 200.

### Runbook: the Sentry uptime monitor (second vendor, done 2026-11-05)

A second company watches `/api/health/jobs`, so a Better Stack outage cannot hide a stalled fleet. The Sentry Developer plan includes one uptime monitor.

**Done on 2026-11-05.** Sentry uptime monitor 7689936 originally watched the homepage, which Better Stack already watches. It was repointed to `https://familiarisenow.com/api/health/jobs` (GET, 300 s interval, 60 s timeout, bearer header, response capture off) and renamed `familiarise job fleet probe (second watcher)`, through the Sentry CLI: `sentry api /organizations/<org>/detectors/7689936/ -X PUT --input -`, with the body piped on stdin so the secret never appears in a command line. The steps below remain the manual equivalent; the 30-second timeout they mention was the dashboard's documented maximum, and the live monitor uses 60 s.

1. In Sentry, open **Monitors** and create an **Uptime Monitor**.
2. **URL:** `https://familiarisenow.com/api/health/jobs`. **Method:** GET.
3. **Headers:** `Authorization: Bearer <CRON_SECRET>`, using the production value. Never put the secret in the URL. Sentry stores header values unmasked and visible to anyone who can edit the monitor, so keep monitor edit rights to the owner.
4. **Interval:** 5 minutes. **Timeout:** 30 seconds (the maximum), for the cold-start stall. Keep the default failure tolerance of three consecutive failures and recovery tolerance of one success.
5. **Alert:** route the uptime issue to the owner's alert email.
6. Verify: the monitor shows its first successful check. If it fails, read the body: `error` first (`JOB_ENVIRONMENT_UNCONFIGURED` and `JOB_HISTORY_UNAVAILABLE` carry nothing else), otherwise the `reasons` list and any `overdue` job explain the 503.

## Daily ops digest and its heartbeat

`ops-digest` is a ticker target that runs once a day at 03:50 UTC (09:20 IST). Its core, `runOpsDigest` in `lib/observability/ops-digest.ts`, emails one digest to `OBSERVABILITY_ALERT_EMAIL` through `deliver()` and then pings a Better Stack heartbeat. It is **always sent**: a quiet day reads "All clear". A missing digest is therefore the alarm. The job never reports to Sentry and never repairs anything.

The email has a one-line headline ("All clear", or "N new, M standing"), then **New since yesterday**, then **Standing** items with their age, then **Context** per section, with at most 10 sample ids per item. Sections: overdue watched jobs and jobs only idle-skipped for 7 days; standing config skips with their first-seen age; pre-launch held email by type with the effective `EMAIL_DELIVERY_MODE`; new and total dead letters (email, notification, outbound webhook, and inbound webhook events past the 168-hour give-up); queue ages past their limits; the last inbound webhook per provider; rejected Better Stack telemetry in 24 hours; the last Sentry ingest canary verdict; paused or muted Better Stack monitors and heartbeats; Upstash usage against `UPSTASH_MONTHLY_COMMAND_CAP`; launch-critical settings as names and booleans only; and release lag. A section whose read fails is shown as unavailable and the email still goes.

### Owner step: create the digest heartbeat (done 2026-11-05)

**Done:** heartbeat `familiarise ops digest (prod)` (523773), period 86400 s, grace 10800 s. It was created paused on purpose, because it would have fired before the first digest existed, and unpaused on 2026-11-05 after the first `ops-digest` ran (03:50 UTC, headline "0 new, 13 standing", heartbeat pinged). Unpausing is part of the step; see [the created-paused lesson](#lessons-from-the-2026-11-05-rollout).

1. Better Stack → Uptime → **Heartbeats** → **Create heartbeat**, named "ops digest".
2. **Expect a heartbeat every:** 24 hours. **Grace period:** 3 hours.
3. **Alert via:** email now; add phone and SMS with the responder seat at launch.
4. Copy the heartbeat URL into the Netlify production environment as `BETTERSTACK_DIGEST_HEARTBEAT_URL` (Functions scope) and redeploy.
5. Verify: run `ops-digest` from the System Jobs page. The email arrives, the heartbeat shows Up, and the run row's `result.summary.heartbeat` reads `pinged`.

The digest pings the URL only after `deliver()` accepted the email. After a failed or held send, or a thrown error, it pings `<url>/fail`, which raises an incident at once. With the URL unset the run row records `heartbeat: "not-configured"`. The recipient must be an own-domain address, because the pre-launch email guard holds anything else and the held send pings `/fail`.

### Owner step: the release-lag token and the Upstash settings (deferred and skipped on 2026-11-05)

**Decision:** `GITHUB_RELEASE_LAG_TOKEN` is deferred (the digest shows "release lag unknown" and nothing pages; production was within 3 commits of `dev`), and the four Upstash settings are skipped (they never existed in GitHub secrets; Upstash is pay-as-you-go at about $0.75 a month, so "Upstash usage unknown" is acceptable). Reasons and alternatives are in [the decision](../decisions/2026-11-05-detector-rollout-and-redundancy.md#r7-to-r9-the-three-deferred-or-skipped-settings). The instructions below apply if either is wanted later.

- **`GITHUB_RELEASE_LAG_TOKEN`:** a fine-grained GitHub token with **Contents: read** on this repository only, in the Netlify production environment. The digest calls the compare API (`BUILD_SHA...dev`) once a day; without the token, release lag reads "unknown" and never pages.
- **Upstash usage:** copy `UPSTASH_MANAGEMENT_API_KEY`, `UPSTASH_EMAIL`, `UPSTASH_DATABASE_ID` and `UPSTASH_MONTHLY_COMMAND_CAP` into the production environment. The usage line used to run in `cron-heartbeat.yml`; at 70% of the cap it becomes a standing digest item.

## Lessons from the 2026-11-05 rollout

The decision record is [2026-11-05-detector-rollout-and-redundancy.md](../decisions/2026-11-05-detector-rollout-and-redundancy.md); the explainer is [How we know a job did not run](../start-here/08-how-we-know-a-job-did-not-run.md). Two lessons belong in every monitor runbook.

### A created-paused monitor looks configured and detects nothing

Heartbeat 521597 was created paused on 2026-10-30 and sat paused until 2026-11-03. For about four days a dead ticker would have alerted nobody, although the monitor existed and the environment variable was set. After creating or changing any monitor, read it back from the vendor and require `paused: false` and status `up`. For a heartbeat, also confirm a ping has arrived:

```bash
curl -sS -H "Authorization: Bearer $BETTERSTACK_API_KEY" https://uptime.betterstack.com/api/v2/heartbeats \
  | jq '[.data[] | {id, name: .attributes.name, status: .attributes.status, paused: .attributes.paused}]'
```

The filter drops each heartbeat's `url`, which is its ping secret.

The `paused` flag is settable at creation and by PATCH, so a monitor that must start paused needs an explicit unpause step in the same runbook.

### A windowed job's first slot can hold the probe red

The probe counts only rows tagged with the serving environment, so a weekly or quarterly job that has never run under a production-tagged row is overdue until it runs. After the 2026-11-04 release the probe answered 503 `JOB_OVERDUE` for exactly `consent-retention-sweeper` and `tds-return-draft`. The fix is to run the job once from a terminal, using the registry key, and then poll the probe:

```bash
curl -X POST -H "Authorization: Bearer $CRON_SECRET" https://familiarisenow.com/api/cleanup/<registry-key>
```

Both jobs were run once at 2026-11-05 08:24 UTC and answered HTTP 200, and the probe then answered 200 with `healthy: true`. The registry key and the run-row name can differ (`tds-return-draft` writes `tds-26q-draft-export`; `jobNameFor` in `lib/cron/schedule.ts` maps them). Never write the secret into a command line that persists; read it from the password manager into the shell session.

## Execution freshness and monitor acceptance

Operational work and CI have separate owners. The active platform ticker owns
production recovery and business jobs; GitHub Actions owns code verification,
security and configuration drift checks, and manual race/load exercises. Remaining
non-money Actions jobs are migration work until their bounded replacement runs
are observed.

A tick's HTTP200 is not a health assertion. Workers return `X-Job-Outcome`, and
execution history distinguishes successful completion, partial failure, failure
and hold. Owned successful finishes advance the shared heartbeat (`cron:heartbeat:last`,
written only by `withCronLock`). Treat it as an activity hint. Monitor individual
capabilities and oldest outstanding work so a healthy email drain
cannot mask stopped recording copies or compliance alerts.

Sentry's `cron-tick` monitor must be active and accept check-ins. Rejected check-ins
produce `cron-checkin-rejected` in function logs. Verify missed-check-in alert
routing separately; a disabled monitor accepts no events. Monitor configuration
and delivery proof are deployment gates, not properties established by a unit test.

A target timeout is ambiguous: the worker can still finish. Recovery drills must
exercise sequential replay and different jobs competing for the same domain row,
in addition to the per-job lease race. Never acknowledge all outstanding work as
healthy merely because another invocation holds the lease.

Execution history records the existing Sentry deployment environment in each completed result. Preview completions in the shared database must not establish production freshness; verify environment configuration as well as completion status.

## Ticker missed-run alerts

The ticker sends a Sentry HTTP check-in after dispatch. Its normal monitor config
is a five-minute schedule, three-minute check-in margin, three consecutive
failures before creating an issue and one success to recover. The HTTP integration
defaults an omitted environment to `production`; inspect accepted check-ins to
confirm the deployed behavior. The monitor detects ticker absence and reported
tick failures. `/api/health/jobs` separately detects missing successful worker
completions; neither establishes that vendor effects or all backlogs are complete.

Better Stack adds a second "did not run" signal. When `BETTERSTACK_HEARTBEAT_URL` (optional, production Functions scope, documented in `.env.sample`) is set, the ticker sends one GET to it per completed tick, with a two-second timeout. A failed ping is logged and never fails the tick; an unset key skips the ping. Create a Better Stack heartbeat monitor with a five-minute period and a grace of a few minutes, and put its URL in that variable. Done on 2026-10-30 as `familiarise cron-tick (prod)` (521597, period 300 s, grace 600 s), but created paused and left so until 2026-11-03; read it back and require status `up` (see [the lessons](#lessons-from-the-2026-11-05-rollout)). A tick that was skipped (not the production deploy, or the fleet switch names another platform) or that stood down as a duplicate sends no ping.

### Configure the monitor and its notification route

1. Locate the existing `cron-tick` monitor in the project identified by the
   configured Sentry coordinates. Inspect its status, muted state, schedule,
   environments and recent check-ins. A disabled monitor rejects check-ins;
   an unmuted monitor with no alert route cannot establish notification delivery.
2. Check the organization's active-monitor allowance before enabling it. An
   active monitor in another project may already consume the included slot.
   Preserve that project's monitoring; do not create an extra monitor for a drill
   or change the subscription as part of this procedure.
3. Enable and unmute the existing monitor through an authenticated operator
   session or the documented cron-monitor API. A source `monitor_config` upsert
   configures the schedule; it does not prove the monitor is enabled. A generic
   metric-monitor API is not a substitute for the cron API.
4. Connect an enabled alert to this specific cron monitor's source. Filter it to
   `production`, trigger on its incident events, and route email directly to a
   verified operator account. Use a 30-minute repeat-notification interval to
   bound incident noise. The general high-priority issue alert is separate and
   must not be assumed to cover every missed check-in.
5. Read the configuration back: verify the connected source is the intended cron
   monitor, the source and alert are enabled, the environment matches, and the
   notification action is active with the correct recipient. Keep credentials in
   protected configuration. Never put tokens, DSNs or signed URLs in evidence.

For connector setup, obtain the numeric source ID with
`get_alert_options(section: "sources")`, matching the project's `cron-tick` source
of type `monitor_check_in_failure`. Pass that ID in `detectorIds`; the native alert
API calls this field `detector_ids`. Read back the connected source and its nested
cron-monitor slug/project. The cron monitor's UUID from the older cron endpoint is
a different identifier and must not be passed as a detector ID.

The Sentry connector may expose alert writes without exposing cron-monitor
updates. If that operation is unavailable, use the documented API with a valid
scoped credential or an authenticated operator session. Record an access failure
as pending work; a saved alert cannot compensate for a disabled monitor.

### Email delivery timing

Familiarise's approved project policy is `digestsMinDelay: 60` and
`digestsMaxDelay: 60` seconds. Read these fields from the project settings API
before a drill. They apply to all issue-alert email in this Sentry project;
changing them requires the project owner's decision. The alert's 30-minute
repeat throttle is a separate setting and remains in force.

A short incident can recover before a delayed email digest is built. Sentry's
published digest implementation excludes resolved issues; an accepted check-in,
created issue or workflow trigger therefore does not establish email delivery.
This is a diagnostic possibility, not access to Sentry's internal delivery logs.
Verify the actual received message and its issue identity, including a digest's
body, rather than substituting a separate test notification or application error.

Before repeating a drill, inspect the alert's `lastTriggered` time and repeat
interval. A regression of the same issue inside that interval may be throttled.
Wait for an ordinary check-in after the interval before starting another bounded
drill; do not silently remove the production throttle. Keep the exclusive
configuration window long enough to include the watchdog's restoration deadline.

### Prove a missed-run alert reaches a human

1. Observe an ordinary production check-in accepted by Sentry. Record its time,
   environment and configured cadence without invoking the production job.
2. Use an authenticated cron-monitor API session for a controlled expectation
   drill. Save the normal monitor and alert configuration in a protected local
   artifact and prepare restoration before changing it. Include monitor status,
   mute state, project, name, slug and scheduling fields, plus alert status, connected
   source IDs, environment, recipient action and repeat interval. Keep the existing
   monitor and route. Do not stop jobs or change the active cron host.
   Arrange an exclusive configuration window with the other operators: the
   documented cron update API does not specify compare-and-set support, and a
   pre-write read alone cannot prevent a concurrent operator write. Do not start
   without that window or verified conditional-update support in the chosen API.
3. Immediately after a fresh ordinary check-in, temporarily set only the monitor's
   expectation to `* * * * *`, `checkin_margin: 1` and
   `failure_issue_threshold: 1`, preserving its other settings. The actual ticker
   continues every five minutes. Read the temporary configuration back. Start an
   independent 180-second restoration watchdog before applying it, and restore
   in the controlling operation's `finally` path as well. Both must call one
   restoration routine with a shared cross-process lock so only one restorer
   writes at a time. Do not start without functioning restoration access.
4. Allow the one-minute expectation to miss its check-in and margin. This
   exercises Sentry's real missing-check-in detection and the **production**
   notification route; it does not mean an ordinary five-minute ticker run was
   missed. Do not fabricate an application exception or an `error` check-in.
   The ticker resubmits normal settings on every check-in. If it restores them
   before an incident appears, or the watchdog deadline arrives first, record
   the drill as inconclusive and restore rather than extending it silently.
5. Verify Sentry creates the missed-check-in incident and that the configured
   operator actually receives its notification. Save sanitized incident/alert
   links, UTC timestamps and the recipient's confirmation. An incident visible
   only in Sentry or an alert's `lastTriggered` timestamp is not a delivery receipt.
6. On success, failure or timeout, the restoration owner first reads both current
   configurations. If they already match the saved normal settings, make no
   write. If they match the drill state with all other saved fields unchanged,
   send a writable monitor payload containing its current project identifier,
   name and complete `config`, replacing only the changed schedule, margin and
   thresholds with their saved values. Preserve other writable fields from the
   verified read-back and omit read-only response metadata. Use a conditional
   write if the API supports one or the exclusive configuration window otherwise.
   Any other drift must stop automatic restoration and be escalated to the
   operator; never replay the full saved snapshot over an unexpected state.
   Read back both configurations and compare every saved configuration
   field, including the unchanged monitor identity/status/mute state and alert
   connection/recipient, before declaring restoration complete. Runtime timestamps
   and check-in counters naturally change. Resolve any mismatch with the operator;
   do not overwrite another operator's concurrent configuration change. Then
   observe the next ordinary check-in and recovery. If restoration fails, alert
   the operator immediately and keep the task open. This drill creates no
   temporary environment; a separate environment would not prove the
   production-filtered route and would keep missing after its sender stopped.

An API config edit sets Sentry's `isUpserting` marker to false; a later SDK/HTTP
configuration upsert sets it true again. This is vendor-managed runtime metadata,
not a writable restoration field. Verify normal scheduling/identity/mute settings
immediately, then observe the next ordinary check-in and its configuration upsert.
Restore only the drill's temporary fields; retain an owner-approved permanent
email-delivery policy rather than reverting it to a previously superseded value.

This evidence closes the ticker missed-run gate only. Keep the ingest canary's
independent email path and the per-capability completion probe: a Sentry outage
and an individual stopped worker have different detection requirements.

### Recorded end-to-end verification

On 26 October 2026, the bounded drill produced missed-check-in issue
`FAMILIARISE_WEB-7Q` at 12:18 UTC. Its production workflow triggered at 12:19 UTC
and its matching email reached the operator's inbox at 12:20:08 UTC. Normal
monitor settings were restored at 12:18:15 UTC; the independent watchdog verified
them, and the ordinary 12:20 production check-in recovered the monitor. The
approved project email delay was 60/60 seconds and the alert repeat throttle
remained 30 minutes. This is receipt evidence for the ticker path; the broader
independent-monitor and worker-completion scope remains open in the
[operating record](https://github.com/Practitionist/familiarise_web/issues/2156#issuecomment-6401498922).

References: [Sentry HTTP check-ins and alert routing](https://docs.sentry.io/product/monitors-and-alerts/monitors/crons/getting-started/http/),
[cron-monitor update API](https://docs.sentry.io/api/crons/update-a-monitor/),
and [the independent ingest canary](../observability/sentry/06-ingest-canary.md).
Email behavior and supported delay bounds:
[digest construction](https://github.com/getsentry/sentry/blob/master/src/sentry/digests/notifications.py),
[project settings validation](https://github.com/getsentry/sentry/blob/master/src/sentry/core/endpoints/project_details.py),
and [monitor update semantics](https://github.com/getsentry/sentry/blob/master/src/sentry/monitors/validators.py).

### Per-tick summary line and lease ceiling

When `ENABLE_BETTERSTACK_TELEMETRY` is `true` and the Better Stack source token and ingest URL are set, each tick posts one `cron-tick summary` log line (category `CRON`, level `error` when any target failed, else `info`) carrying the duration, the ok and accepted counts, the held target names, the failed targets with their statuses and the `oldestPendingAgeS` gauges. It goes through the same emitter as every other event, `emitTelemetryLog` in `lib/observability/betterstack-telemetry.ts`, which validates a fixed set of fields with Zod and never throws. A 402, 403, 5xx, other non-2xx or network failure is logged as `betterstack-ingest-rejected` or `betterstack-ingest-unreachable` with the status and never reaches Sentry; a send never affects the tick. Inside a job run the same outcomes are counted on the run row as `result.telemetry`. The ticker reads `SENTRY_DSN` and falls back to `NEXT_PUBLIC_SENTRY_DSN`.

On Netlify (`onNetlify()` in `lib/runtime-host.ts`: the build-inlined `NETLIFY=true`, or the runtime `SITE_ID` that functions see) `withCronLock` caps every lease at 90 seconds. A synchronous Netlify function stops at 60 seconds, but a background function (such as the recording transfer) may run for 15 minutes, so the cap is safe only because `startLeaseRenewal` refreshes a live run's lease every third of the TTL (30 seconds). The cap therefore never expires a run that is still alive; it only bounds how long a killed run's `RUNNING` row blocks the next ticks, so a killed run recovers within one 90-second lease window. Other hosts keep the per-job TTL. The ticker still files a 409 under `lockHeld`, a distinct field in the tick body and summary line, never under `ok`.

### Owner step: the tick-summary freshness alert

The heartbeat and the uptime monitors are separate requests from log ingest, so they stay green when Better Stack refuses log events (402 once the free quota or spending limit is spent, 403 for a bad source token). The freshness alert closes that gap: it fires when no `cron-tick summary` event has arrived for 15 minutes, which is three missed five-minute ticks. A rejected summary, a stopped ticker, telemetry switched off and a revoked token all look the same to it, and that is the point: it is the one catch-all for missing telemetry. Configure it in Better Stack by hand; no code creates vendor resources.

1. Open **Telemetry**, then **Dashboards**, create a dashboard named `Jobs`, and add a chart with **+**.
2. Choose an SQL query on the production logs source and paste:

   ```sql
   SELECT {{time}} AS time, count(*) AS value
   FROM {{source}}
   WHERE time BETWEEN {{start_time}} AND {{end_time}}
     AND JSONExtract(raw, 'message', 'Nullable(String)') = 'cron-tick summary'
   GROUP BY time
   ```

3. In the chart's sidebar open **Alerts** and add a **Threshold** alert named `Ticker telemetry stale`: trigger when `value` is **below 1**, run it every 5 minutes on data from the last 15 minutes, and set **If data is missing** to **Start an incident**. Keep the confirmation period at 1 minute.
4. Route it to email (the default) and to the ops Slack channel through the Better Stack Slack integration. Leave call, SMS and push off: they need the responder seat, which is bought at launch.
5. Prove it: unset `ENABLE_BETTERSTACK_TELEMETRY` on a branch deploy for 20 minutes, or pause the source, and confirm an incident opens and resolves.

The summary is sent only by the active platform's ticker (`ops:active_cron_platform`). After a fleet switch the new host's ticker must emit the same `cron-tick summary` event, or this alert fires; that is the intended reading.

### Missing-data policy per capability

A Better Stack alert must say what an absent value means. The rule: a money queue that cannot be seen is treated as a money queue in trouble, while a non-money gauge that is missing is left to the freshness alert above, so one telemetry outage opens one incident rather than seven.

| Capability                            | Signal                                         | If data is missing (Better Stack setting) | Why                                                                                         |
| ------------------------------------- | ---------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------- |
| Ticker telemetry                      | `cron-tick summary` count                      | Start an incident                         | It is the catch-all: absence is the only symptom of a refused or stopped ingest.            |
| Refunds the bookings owe              | `oldestPendingAgeS.refundsOwed`                | Start an incident                         | A customer is owed money; not knowing is as bad as a breach.                                |
| Payouts in flight or approved         | `oldestPendingAgeS.payoutsStuck`               | Start an incident                         | An expert or organisation is owed money.                                                    |
| Overdue invoice notices (dunning)     | `oldestPendingAgeS.dunningNotices`             | Start an incident                         | A missed notice delays collection and the suspension clock.                                 |
| Disputes inside their response window | `oldestPendingAgeS.disputesDue`                | Start an incident                         | A missed evidence deadline loses the dispute by default.                                    |
| Unprocessed gateway webhooks          | `oldestPendingAgeS.webhookEvents`              | Do not start an incident                  | Covered by the freshness alert; the reconcile sweeps are a second path for the money.       |
| Email retries                         | `oldestPendingAgeS.emailRetries`               | Do not start an incident                  | Covered by the freshness alert.                                                             |
| Notification (bell) retries           | `oldestPendingAgeS.notificationRetries`        | Do not start an incident                  | Covered by the freshness alert.                                                             |
| Ingest rejections inside job runs     | `SystemJobExecution.result.telemetry.rejected` | Not alerted                               | Postgres evidence for diagnosis; a rejected tick summary already trips the freshness alert. |

The gauges themselves, their thresholds and the alert query for each are in the next section, [the oldest-pending-age alerts](#owner-step-the-oldest-pending-age-alerts).

### Owner step: the oldest-pending-age alerts

**Status (2026-11-05): all eight alerts exist and are paused.** They were created through the Telemetry API (`POST https://telemetry.betterstack.com/api/v2/explorations`, then `POST /api/v2/explorations/<id>/alerts` with `paused: true`), each as an exploration holding this section's SQL on the `familiarise-prod` source (2816999), with the thresholds and missing-data rules in the tables above. Each runs every 300 s over a 900 s window, with a 60 s confirmation and email only.

| Alert                          | Exploration | Alert id   |
| ------------------------------ | ----------- | ---------- |
| `Ticker telemetry stale`       | 895174      | 2988727965 |
| `Backlog: refundsOwed`         | 895175      | 2988727966 |
| `Backlog: payoutsStuck`        | 895176      | 2988727967 |
| `Backlog: dunningNotices`      | 895177      | 2988727968 |
| `Backlog: disputesDue`         | 895178      | 2988727969 |
| `Backlog: webhookEvents`       | 895179      | 2988727970 |
| `Backlog: emailRetries`        | 895180      | 2988727971 |
| `Backlog: notificationRetries` | 895181      | 2988727972 |

Unpause an alert only after the go-live data reset, and only once every money gauge in the latest `cron-tick summary` event reads zero. To unpause it, send `PATCH https://telemetry.betterstack.com/api/v2/alerts/<alert id>` with `{"paused": false}`. Then list `GET /api/v2/alerts` and require `paused: false`. Whether the backlog gauges arrive in the summary events is not yet proven: before unpausing, open each exploration and confirm it plots values rather than nothing.

Every tick's `cron-tick summary` event carries `oldestPendingAgeS`, an object of seven gauges. Each gauge is the number of seconds the oldest item in one queue has waited past its due point, and 0 means nothing is waiting. The tick's slot claim (`POST /api/health/jobs/tick`) reads all seven in one SQL statement (`readPendingAges` in `lib/cron/pending-ages.ts`) inside the transaction that already runs the idle probes, and only while the probes' 2-second budget lasts, so the claim's worst case stays 2.75 s and costs one extra round trip of about 62 ms from Netlify Singapore. A gauge fault never changes which targets run; the event then simply has no `oldestPendingAgeS`, which the missing-data policy above handles. There is no new ticker target and no new job.

The thresholds live in one place in code, `PENDING_AGE_LIMITS_MS` in `lib/cron/pending-ages.ts`, which the Stuck work page also uses. Each is set from the cadence of the job that drains the queue in `lib/cron/schedule.ts`.

| Gauge (`oldestPendingAgeS.*`) | Due point                                                                                                                   | Alert when over | Draining job and cadence                                                                                                                            | Why this threshold                                                                                                                                                                                                                    |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `refundsOwed`                 | `Payment.refundOwedAt`                                                                                                      | 3,600 s (1 h)   | `retry-auto-refunds`, every 15 min at :10, after a 15-minute grace                                                                                  | A healthy owed refund is first tried within 30 minutes (grace plus one slot). After one failed attempt the marker backs off for 1 h, so a marker older than 1 h has failed at least once or its sweep has stopped.                    |
| `payoutsStuck`                | `updatedAt` of an `APPROVED` or `PROCESSING` expert or organisation payout                                                  | 14,400 s (4 h)  | `process-payouts` hourly at :00; `reconcile-payout-status` every 2 h (01:40, 03:40 UTC and so on); `handle-stuck-payouts` every 2 h, acting at 24 h | Four hours is four send slots for an approved payout and two status polls for one in flight. Instant transfer modes usually settle within minutes, so this pages long before the 24-hour stuck sweep acts.                            |
| `dunningNotices`              | `dueDate` for an `ISSUED` invoice not yet marked overdue; the last reminder (or the overdue stamp) plus 7 days for the next | 93,600 s (26 h) | `dunning`, in the 23:30–02:30 UTC window at 00:10, 01:10 and 02:10                                                                                  | The job uses the window's start as its cut-off, so a notice that falls due just after 23:30 UTC waits about 24 h 40 min for the next night's first slot. Twenty-six hours means a whole nightly window has passed without the notice. |
| `disputesDue`                 | 48 hours before `Dispute.dueBy`, for `NEEDS_RESPONSE` and `WARNING_NEEDS_RESPONSE`                                          | 0 s             | `reconcile-disputes` hourly                                                                                                                         | Evidence is submitted by a person. Any dispute inside 48 hours of its deadline needs one now, which matches the 48-hour line in the job machinery catalog.                                                                            |
| `webhookEvents`               | `WebhookEvent.receivedAt` of an unprocessed event younger than the sweep's 7-day give-up                                    | 3,600 s (1 h)   | `sweep-stuck-webhook-events`, every 15 min, re-driving events stale for 6 minutes                                                                   | Four sweep slots, and the sweep's own alert age (`ALERT_AGE_HOURS = 1`).                                                                                                                                                              |
| `emailRetries`                | `FailedEmail.nextRetryAt` (or `createdAt`) of a `PENDING` or `RETRY` row                                                    | 3,600 s (1 h)   | `retry-failed-emails`, every 15 min at :05                                                                                                          | Four relay slots past the row's own retry time.                                                                                                                                                                                       |
| `notificationRetries`         | The later of `nextRetryAt` (or `createdAt`) and `notBefore`, for a `PENDING` or `RETRY` outbox row                          | 3,600 s (1 h)   | `drain-notification-outbox`, every 10 min at :05                                                                                                    | Six relay slots past the row's own retry time.                                                                                                                                                                                        |

Create one chart and one Threshold alert per gauge on the `Jobs` dashboard. The query is the same for each; replace `refundsOwed` with the gauge name:

```sql
SELECT {{time}} AS time,
  max(JSONExtract(raw, 'oldestPendingAgeS', 'refundsOwed', 'Nullable(Int64)')) AS value
FROM {{source}}
WHERE time BETWEEN {{start_time}} AND {{end_time}}
  AND JSONExtract(raw, 'message', 'Nullable(String)') = 'cron-tick summary'
GROUP BY time
```

Name each alert `Backlog: <gauge>`, trigger it when `value` is above the threshold in the table, run it every 5 minutes on data from the last 15 minutes, and set **If data is missing** from the missing-data policy table above. Route every alert to email and the ops Slack channel now. At launch, once the responder seat is bought, add phone and SMS to the four money gauges (`refundsOwed`, `payoutsStuck`, `dunningNotices`, `disputesDue`) through an escalation policy; the other three stay on email and Slack.

On the shared development and production database the money gauges are not zero today: seeded and QA rows (an owed refund about 15 days old, payouts approved or in flight for days, two disputes past their deadline) would fire the money alerts as soon as they are created. The owner decided on 2026-11-01 to create the alerts muted and unmute them after the go-live data reset, rather than deleting rows on the shared database; the [money go-live checklist](../finance/70-operations/07-go-live-checklist.md) carries the unmute step. The **Stuck work** page in the console lists the same items, plus `FAILED` payouts, which need a person but are not part of `payoutsStuck` (that gauge covers only `APPROVED` and `PROCESSING` payouts). The page ages disputes from `dueBy` itself ("overdue by 42 d"), while the `disputesDue` gauge counts from 48 hours before it (44 days for the same row) so the alert fires early; the two numbers differ by design.

### Failure escalation

Every failing target appears in the per-tick summary line. A one-off failure stays out of Sentry: the ticker writes a `cron-tick.target-failed-once` log line (with `class: platform` when the body is Netlify's own `Internal Server Error - Request ID` page). It becomes an error issue fingerprinted per target only after it has gone three of its own cadences without a `COMPLETED` run. The ticker reads that history from `GET /api/health/jobs/streaks?targets=a,b` (bearer `CRON_SECRET`, read-only), which resolves each target to the `jobName` its core writes (`jobNameFor` in `lib/cron/schedule.ts`; most match the target name, eight differ, for example `abandoned-payments` writes `cleanup-abandoned-payments`) and returns that job's last `COMPLETED` start time from `SystemJobExecution`; it asks only for targets that are about to be reported, and an unreachable endpoint or a job with no recent rows counts as a one-off, so it is logged only. The history comes from Postgres because the ticker keeps no state and a Redis failure counter is outside the allowed Redis uses. A platform 5xx leaves no execution row, which is why the test is the absence of a recent `COMPLETED` run rather than a run of `FAILED` rows. Reports remain limited to one per target per hour, and the `cron-tick` monitor check-in is unchanged: it reports `error` on any tick with a failed target and the monitor's threshold of three consecutive failed check-ins does the escalation.

Every target, `sentry-ingest-canary` and `stream-control-plane-drift` included, writes an execution row, so every failure can escalate; the canary is still never reported to Sentry, because Sentry may be the thing that is down. A jest test scans the sources and fails if a target resolves to a name no `withCronLock` call uses.
