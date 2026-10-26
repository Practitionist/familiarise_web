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
- **Get in touch URL**: `mailto:support@familiarisenow.com`
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
curl -s "https://uptime.betterstack.com/api/v2/monitors" \
  -H "Authorization: Bearer <your-token>" | \
  python3 -m json.tool | grep -A3 '"url"'
```

Should return both monitors with their status.

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

| Item                   | Value                                                          |
| ---------------------- | -------------------------------------------------------------- |
| **BetterStack URL**    | https://uptime.betterstack.com/team/t332379                    |
| **Email**              | teetangh@gmail.com                                             |
| **Plan**               | Free                                                           |
| **Monitor 1**          | `https://familiarisenow.com` (public: "Website")               |
| **Monitor 2**          | `https://familiarisenow.com/api/health` (public: "API Health") |
| **Check frequency**    | 3 minutes (free plan minimum)                                  |
| **API Health timeout** | 60 s request timeout, 1 min confirmation (see Step 3, #1557)   |
| **Alert type**         | Email only (push/SMS require paid plan)                        |
| **Status page**        | https://familiarise.betteruptime.com                           |
| **API token name**     | "Familiarise Production"                                       |
| **API base URL**       | `https://uptime.betterstack.com/api/v2`                        |

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

Configure an external HTTP monitor for `GET /api/health/jobs` after deploying the
route. Supply `Authorization: Bearer <CRON_SECRET>` as a protected monitor header;
never put the secret in the URL. The endpoint is read-only, uncached and returns
503 when required completion evidence is missing/stale or history cannot be read.
It returns 401 before querying for an unauthorized caller.

The required capabilities and completion SLOs live in
`lib/cron/operational-health.ts`. These are monitoring budgets, not a second
scheduler. Fifteen-minute recovery/delivery loops have 45 minutes to accommodate a
missed tick and lease recovery; thirty-minute session-outcome loops have 90 minutes;
support SLA scanning has 1 hour. The required set follows the current entries in
`lib/cron/operational-health.ts`, including longer budgets for daily jobs. Check
the schedule catalog before enabling a capability's absence monitor; remaining
Actions-only jobs need an observed replacement before becoming required here.

The probe queries recent COMPLETED executions by their actual core job names,
including `reconcile-pending-refunds` and `send-appointment-reminders`, whose HTTP
slugs differ. It uses `endedAt`, not a new RUNNING attempt or shared heartbeat.
One healthy email drain cannot conceal stopped refund reconciliation or session
reminders. FAILED, CANCELLED and RUNNING rows do not refresh this evidence.

This checks a selected always-on operational set. Calendar/configuration-gated
jobs, backlog drain capacity, vendor effect correctness, and alert delivery need
separate checks. Existing historical COMPLETED rows are only as trustworthy as the
worker's outcome recording; deploy truthful outcome recording and exercise real
failure cases before claiming complete coverage. The probe does not write rows,
invoke jobs, send a test payment or repair vendor state.

During an approved maintenance window, suppress notifications through the external
monitor's maintenance mechanism; do not turn a blocked completion into success.
The probe reads history without calling the job maintenance gate. Before monitor
activation, deploy and verify maintenance refusal and truthful outcome recording:
a refusal before the lease creates no completion, and held or failed runs must
not be recorded as COMPLETED. Exercise OFFLINE, DEGRADED financial-job holds and
unreadable maintenance state against those worker gates. As prior successes age
out, the probe returns 503 even during maintenance; notification suppression does
not change the recorded evidence.

After deployment verify both a healthy probe and a controlled missing-capability
failure in an isolated environment. A 200 from the existing public `/api/health`
remains insufficient proof of fleet coverage.

See [Better Stack HTTP monitor configuration](https://betterstack.com/docs/uptime/api/create-a-new-monitor/)
for protected request headers and expected-status monitoring.

The shared database also contains preview/admin executions. This probe requires
execution `result.environment` to match the serving deployment's existing
`NEXT_PUBLIC_SENTRY_ENVIRONMENT` (or `SENTRY_ENVIRONMENT`). Untagged historical rows
do not establish production freshness. Missing environment configuration returns
503 `JOB_ENVIRONMENT_UNCONFIGURED`. Deploy environment-tagged execution recording
before expecting the probe to turn healthy, and verify context configuration;
environment tags reduce ambiguity but do not replace isolated production data.

The same environment precedence must be used by the recorder and probe. An unset
public label uses the server label; an explicitly empty public label fails
configuration instead of falling back. Confirm required workers are scheduled and
producing these tagged completions before enabling the monitor; a configured SLO
does not establish that its scheduler is active.

## Execution freshness and monitor acceptance

Operational work and CI have separate owners. The active platform ticker owns
production recovery and business jobs; GitHub Actions owns code verification,
security and configuration drift checks, and manual race/load exercises. Remaining
non-money Actions jobs are migration work until their bounded replacement runs
are observed.

A tick's HTTP200 is not a health assertion. Workers return `X-Job-Outcome`, and
execution history distinguishes successful completion, partial failure, failure
and hold. Owned successful finishes advance the shared heartbeat, which the daily
Actions watchdog also writes. Treat it as an activity hint. Monitor individual
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

When `ENABLE_BETTERSTACK_TELEMETRY` is `true` and the Better Stack source token and ingest URL are set, each tick posts one `cron-tick summary` log line (category `CRON`, level `error` when any target failed, else `info`) carrying the duration, the ok and accepted counts, the held target names and the failed targets with their statuses. It is a second sink that does not depend on Sentry, it is sent once per tick rather than per target, and a send failure never affects the tick. The ticker reads `SENTRY_DSN` and falls back to `NEXT_PUBLIC_SENTRY_DSN`.

On Netlify (`NETLIFY=true`) `withCronLock` caps every lease at 90 seconds, because a Netlify invocation cannot outlive 60 seconds and a longer lease only keeps a killed run's `RUNNING` row blocking the next ticks. A killed run therefore recovers within one lease window. Other hosts keep the per-job TTL. The ticker still files a 409 under `lockHeld`, a distinct field in the tick body and summary line, never under `ok`.
