# Stream Video, Stream Chat & Concurrency — MCP Execution Cookbook

> **Companion to:** [`_shared/shared-setup.md`](./shared-setup.md) and [`_shared/case-template.md`](./case-template.md).
> Every workflow prompt cites recipes from this file by `§` anchor so subagents execute deterministic, zero-local-server verification steps.

---

## §1. Zero-Local-Server Check & Netlify Deploy Preview Targeting

Before running any Chrome DevTools step, verify zero local servers are running and resolve the target Netlify preview URL:

```bash
# Verify no local next dev / start servers exist
ps aux | awk '/next-server|next dev/ && !/awk/'
# Determine latest PR deploy preview URL (e.g., https://deploy-preview-2012--familiarise.netlify.app)
gh pr view <PR_NUMBER> --json number,url
```

---

## §2. Better Auth Session Injection on `*.netlify.app` (`Chrome DevTools MCP` + `Supabase MCP`)

Because Netlify Deploy Previews run over HTTPS (`https://deploy-preview-<PR>--familiarise.netlify.app`), Better Auth checks the `__Secure-better-auth.session_token` cookie (`lib/auth-session-lookup.ts:79-110`), signed as:
`encodeURIComponent(rawToken + "." + base64(HMAC_SHA256(BETTER_AUTH_SECRET, rawToken)))`

### Step A — Insert Active Session Row in Supabase (`mcp__supabase__execute_sql`)
```sql
-- Project ID: pzmbxqdgibfkhjwzeprf
INSERT INTO "sessions" (
  id,
  token,
  "userId",
  "expiresAt",
  "ipAddress",
  "userAgent",
  "createdAt",
  "updatedAt"
)
VALUES (
  'sess_qa_' || encode(gen_random_bytes(12), 'hex'),
  '<RAW_TOKEN>',
  '<USER_ID>', -- e.g. 'euyQyTP7LYjIqguPZWtWOyE5mYl86ud4' (consultee) or 'cmu15jwjr0000c7yobiusdtlt' (consultant)
  NOW() + INTERVAL '12 hours',
  '127.0.0.1',
  'QA-Stream-Suite-Subagent/1.0',
  NOW(),
  NOW()
)
RETURNING id, token, "userId", "expiresAt";
```

### Step B — Sign Token with `BETTER_AUTH_SECRET`
```bash
node -e '
const fs = require("fs");
const crypto = require("crypto");
const env = fs.readFileSync("/usr/local/google/home/kaustavg/github/familiarise_web/.env", "utf8");
const secret = env.match(/^BETTER_AUTH_SECRET=["'\'']?([^"'\''\n]+)/m)[1];
const token = process.argv[1];
const sig = crypto.createHmac("sha256", secret).update(token).digest("base64");
console.log(encodeURIComponent(`${token}.${sig}`));
' "<RAW_TOKEN>"
```

### Step C — Inject Cookie into Chrome DevTools on the Netlify Preview Origin
```javascript
// 1. Navigate to the deploy preview origin first:
mcp__chrome-devtools__navigate_page({
  url: "https://deploy-preview-<PR>--familiarise.netlify.app/auth/signin"
})

// 2. Inject signed __Secure-better-auth.session_token cookie:
mcp__chrome-devtools__evaluate_script({
  function: `() => {
    document.cookie = "__Secure-better-auth.session_token=<SIGNED_COOKIE_VALUE>; Path=/; Secure; SameSite=Lax; Max-Age=43200";
    return document.cookie;
  }`
})

// 3. Navigate to target authenticated route and capture snapshot + screenshot:
mcp__chrome-devtools__navigate_page({
  url: "https://deploy-preview-<PR>--familiarise.netlify.app/dashboard/consultee/12cb2c39-e7ca-4ec0-b72b-1a19257c9c44/appointments"
})
mcp__chrome-devtools__take_snapshot()
```

---

## §3. Non-Overlapping Live Window Shifting Recipe (`Supabase MCP`)

Because `occurrence_no_confirmed_overlap` blocks any two confirmed occurrences for the same `consultantProfileId` from overlapping, shift test occurrences into sequential non-overlapping windows around `NOW()` when testing live video join:

```sql
-- Project ID: pzmbxqdgibfkhjwzeprf
-- Shift target occurrence into an active live window [NOW() - 5m, NOW() + 55m) after verifying zero overlap:
UPDATE "AppointmentOccurrence"
SET
  "startsAt" = NOW() - INTERVAL '5 minutes',
  "endsAt"   = NOW() + INTERVAL '55 minutes',
  "isTentative" = false,
  "updatedAt" = NOW()
WHERE id = '<OCCURRENCE_ID>'
RETURNING id, "appointmentId", "consultantProfileId", "startsAt", "endsAt", "isTentative";
```

When setting up multiple occurrences for the **same** consultant in one test run, stagger them sequentially:
- Slot 1 (`WEBINAR`): `[NOW() - 10m, NOW() + 20m)` (currently live)
- Slot 2 (`CLASS`): `[NOW() + 25m, NOW() + 85m)` (upcoming / join-ahead window if shifted to `[NOW() + 5m, NOW() + 65m)` after Slot 1 finishes)
- Slot 3 (`CONSULTATION`): `[NOW() + 90m, NOW() + 120m)`
- Slot 4 (`SUBSCRIPTION`): `[NOW() + 125m, NOW() + 155m)`

---

## §4. `BEGIN ... ROLLBACK` Constraint Probe Recipe (`Supabase MCP`)

To verify PostgreSQL exclusion (`23P01`) and check (`23514`) constraints safely on `pzmbxqdgibfkhjwzeprf` without leaving dirty rows:

```sql
-- Expect ERROR: 23P01: conflicting key value violates exclusion constraint "occurrence_no_confirmed_overlap"
BEGIN;
  UPDATE "AppointmentOccurrence"
  SET
    "startsAt" = (SELECT "startsAt" FROM "AppointmentOccurrence" WHERE id = 'e2ccb6d2-26b3-4860-9f27-336af511bf21'),
    "endsAt"   = (SELECT "endsAt"   FROM "AppointmentOccurrence" WHERE id = 'e2ccb6d2-26b3-4860-9f27-336af511bf21'),
    "isTentative" = false
  WHERE id = '7b778b43-53ca-4e4b-992e-34f5d4f201c2';
ROLLBACK;
```

```sql
-- Expect ERROR: 23514: new row for relation "AppointmentOccurrence" violates check constraint "occurrence_confirmed_requires_consultant_chk"
BEGIN;
  UPDATE "AppointmentOccurrence"
  SET "consultantProfileId" = NULL, "isTentative" = false
  WHERE id = 'e2ccb6d2-26b3-4860-9f27-336af511bf21';
ROLLBACK;
```

---

## §5. Stream Video & Chat Verification Recipes (`Stream IO MCP`)

### A. Verify Provisioned Stream Video Call (`mcp__stream-io__video_get_call`)
```json
{
  "ServerName": "stream-io",
  "ToolName": "video_get_call",
  "Arguments": {
    "call_type": "default",
    "call_id": "occurrence-<OCCURRENCE_ID>"
  }
}
```
**Key Assertions on `call`:**
- `call.created_by.id === "<HOST_USER_ID>"` (never consultee's user ID!)
- `call.settings_override.video.target_resolution` has `width: 1280, height: 720, bitrate: 2500000`
- `call.settings_override.audio.default_device === "speaker"`
- `call.settings_override.backstage.enabled === true` (for `WEBINAR`/`CLASS`) or `false` (for `CONSULTATION`/`SUBSCRIPTION`/`TRIAL`)
- `call.custom.organizationId` matches parent `Appointment.organizationId` (when org-scoped)

### B. Verify Call Member Roles (`mcp__stream-io__video_query_call_members`)
```json
{
  "ServerName": "stream-io",
  "ToolName": "video_query_call_members",
  "Arguments": {
    "call_type": "default",
    "call_id": "occurrence-<OCCURRENCE_ID>",
    "filter_conditions": {}
  }
}
```
**Key Assertions on `members`:**
- Primary host (`created_by.id`): owner/host capabilities
- Accepted `CO_HOST` / `CO_INSTRUCTOR` / `MODERATOR` collaborators: `role === "co_presenter"` (or graceful `call_member` fallback)
- Regular consultees / attendees: `role === "call_member"`

### C. Verify Stream Chat Channel & Roster (`mcp__stream-io__chat_get_channel` & `chat_query_members`)
```json
{
  "ServerName": "stream-io",
  "ToolName": "chat_get_channel",
  "Arguments": {
    "channel_type": "team",
    "channel_id": "webinar-<WEBINAR_ID>"
  }
}
```

---

## §6. Browser Network, Console & Sentry Telemetry Sweep

After every UI interaction in Chrome DevTools:
1. `mcp__chrome-devtools__list_network_requests()` — inspect `POST /api/meetings/<id>/join`, `GET /api/meetings/<id>/session`, `POST /api/meetings/<id>/live`, `POST /api/meetings/<id>/extend`, `POST /api/meetings/<id>/end`. Assert HTTP `200` (or expected `403`/`404`/`409` on negative tests) and zero unexpected `500` responses.
2. `mcp__chrome-devtools__list_console_messages()` — assert zero unhandled React hydration crashes, `StreamVideoClient` errors, or red error toasts (`Error joining meeting`).
3. `mcp__sentry__search_issues({ organizationSlug: "practitionist", naturalLanguageQuery: "is:unresolved firstSeen:>-1h", limit: 20 })` — verify zero newly introduced unhandled exceptions.
