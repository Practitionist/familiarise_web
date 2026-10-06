# Stream Video, Stream Chat & Concurrency — Case Template & Bug Reporting Contract

> **Companion to:** [`_shared/shared-setup.md`](./shared-setup.md) and [`_shared/mcp-recipes.md`](./mcp-recipes.md).
> Defines the mandatory structure for every test case and the structured bug report schema returned by test subagents to the main orchestrator agent.

---

## §1. Standard Per-Case Structure

Every workflow file under `prompts/stream-chat-video-tests/<N-folder>/<N.seq>-<slug>.md` contains **3 to 6 end-to-end workflows** structured as:

```markdown
## Workflow <ID>: <Concise Workflow Title> (`Priority: P0 | P1 | P2 | Edge | Impossible`)

### Preconditions
- **Target Preview URL:** `https://deploy-preview-<PR>--familiarise.netlify.app`
- **Active Persona(s):** <Consultant / Consultee / Collaborator / Org Admin>
- **Supabase Pre-Check (`execute_sql`):**
  ```sql
  <exact SQL verifying or setting up fixture state>
  ```

### Step-by-Step Execution
1. **[Supabase / Auth]** <Session cookie injection per `mcp-recipes.md §2`>
2. **[Chrome DevTools]** <UI navigation / click / `evaluate_script` fetch probe>
3. **[Stream IO MCP]** <`video_get_call` / `chat_get_channel` inspection>
4. **[Supabase MCP]** <Post-action DB state verification>

### Expected Invariants & Assertions
- **UI & Network:** <HTTP status code, URL redirect, absence of error toasts, screenshot artifact>
- **Database (`pzmbxqdgibfkhjwzeprf`):** <`Meeting`, `AppointmentOccurrence`, `AppointmentParticipant`, or SQLSTATE assertion>
- **Stream State (`1366319`):** <`created_by.id`, `settings_override`, `members`, `custom` metadata>
- **Sentry & Console:** <Zero unhandled exceptions or unexpected 5xx logs>

### Teardown / Window Restoration
- <Exact SQL to clean up ephemeral rows or restore shifted windows>
```

---

## §2. Subagent-to-Main-Agent Bug Report Protocol (`QA_WORKFLOW_FAILURE_REPORT`)

When a QA subagent executes any workflow in `prompts/stream-chat-video-tests/` and observes a failure, regression, or unexpected 4xx/5xx/UI toast, it **MUST** immediately emit the following JSON block in its message back to the main agent:

```json
{
  "reportType": "QA_WORKFLOW_FAILURE_REPORT",
  "workflowFile": "prompts/stream-chat-video-tests/<folder>/<file>.md",
  "workflowId": "<e.g., Workflow 0.2.1>",
  "priority": "P0 | P1 | P2 | EDGE | IMPOSSIBLE",
  "verdict": "FAIL | PARTIAL | BLOCKED",
  "environment": {
    "previewUrl": "https://deploy-preview-<PR>--familiarise.netlify.app",
    "commitSha": "<git-sha>",
    "supabaseProjectId": "pzmbxqdgibfkhjwzeprf",
    "streamAppId": "1366319",
    "actorUserId": "<users.id>",
    "actorRole": "CONSULTANT | CONSULTEE | CO_PRESENTER | ORG_ADMIN | UNBOUND"
  },
  "reproduction": {
    "stepsExecuted": [
      "1. Injected session cookie for <actorEmail> on deploy-preview-<PR>",
      "2. Navigated to <path> and clicked Join on <appointmentId> / <occurrenceId>"
    ],
    "expectedOutcome": "<exact expected HTTP status / UI route / Stream call state>",
    "observedOutcome": "<exact observed error toast / HTTP response / DB state>"
  },
  "databaseEvidence": {
    "sqlExecuted": "SELECT id, \"streamCallId\", platform, \"slotOfAppointmentId\" FROM \"Meeting\" WHERE \"slotOfAppointmentId\" = '<id>';",
    "rowsReturned": []
  },
  "streamEvidence": {
    "toolCalled": "mcp__stream-io__video_get_call",
    "targetCid": "default:occurrence-<id>",
    "observedPayload": {}
  },
  "browserAndSentryTrace": {
    "failingNetworkRequest": {
      "method": "POST",
      "url": "https://deploy-preview-<PR>--familiarise.netlify.app/api/meetings/<id>/join",
      "status": 500,
      "responseBody": {}
    },
    "consoleErrors": [],
    "screenshotArtifactPath": "/usr/local/google/home/kaustavg/.gemini/jetski/brain/<conv-id>/<filename>.png",
    "sentryIssueIds": []
  },
  "rootCauseSuspects": [
    {
      "filePath": "actions/stream/meetings/meeting.action.ts",
      "lineRange": "390-460",
      "hypothesis": "<Concrete code-level root-cause hypothesis>",
      "proposedFix": "<Minimal safe diff summary>"
    }
  ],
  "cleanupStatus": {
    "fixturesRestored": true,
    "cleanupSqlRun": "<SQL executed>"
  }
}
```
