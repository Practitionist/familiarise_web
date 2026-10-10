# Deflection and Support CSAT

Self-serve deflection rate ("what fraction of support conversations resolve without human intervention") is the primary operational signal for deterministic support flowcharts, paired directly with customer satisfaction (CSAT) across both self-serve tree terminals and human-resolved support cases.

```mermaid
flowchart LR
  Turn["Terminal Support Turn (APPOINTMENT or PLATFORM)"] --> Record["recordFlowOutcome() -> outcomeId"]
  Record -->|RESOLVED| TreePrompt["Inline 1-5 Star Prompt (PlatformSupportSheet / SessionConversation)"]
  TreePrompt -->|POST /api/support/flow-outcomes/id/rating| CASFlow["rateFlowOutcome() CAS (helpfulRating IS NULL)"]
  TreePrompt -->|Score <= 3| HumanOffer["Offer 'Get help' / Human Exit (no auto-ticket)"]
  Record -->|ESCALATED| Case["Unified SupportCase / Legacy SupportTicket"]
  Case -->|Operator Resolves| Outbox["Stage 24h Delayed Bell Survey (dedupeKey: csat:id:resolvedAt)"]
  Outbox -->|POST /api/support/cases/caseId/csat (<= 28d)| CASCase["submitSupportCaseCsat() CAS (csatRating IS NULL)"]
```

---

## 1. The Deflection Counter (`SupportFlowOutcome`)

`SupportFlowOutcome` records one row per **terminal** support turn across both intake scopes via [`recordFlowOutcome`](../../lib/support/deflection.ts):

- **Direct `outcomeId` return (`Promise<string | null>`)**: `recordFlowOutcome(input, tx?)` creates the `SupportFlowOutcome` row and returns `row.id` (`outcomeId`) directly to the caller (`runSupportTurn` in [`lib/support/service.ts`](../../lib/support/service.ts) and `handleSelfServeTurn` / `handleEscalatedTurn` in [`app/api/support/platform/route.ts`](../../app/api/support/platform/route.ts)), eliminating any secondary database `findFirst` lookup.
- **Counter-only schema**: Stores `scope` (`"APPOINTMENT" | "PLATFORM"` as `VarChar(32)` so additional surfaces never require an enum migration), `flowKey`, `terminalNodeId`, machine-readable `reason`, `outcome` (`RESOLVED` or `ESCALATED`), `userId`, and `organizationId`. Message bodies are never copied onto analytics rows.
- **Fault isolation**: When invoked outside an explicit Prisma transaction (`tx`), `recordFlowOutcome` catches database errors, logs structured telemetry, and returns `null` so a metrics failure can never roll back or break an active customer support turn.

---

## 2. Half One: Self-Serve Tree CSAT (`SupportFlowOutcome.helpfulRating`)

Because self-serve `RESOLVED` turns do not create a ticket or case, tree satisfaction attaches directly to the terminal outcome row (`SupportFlowOutcome.helpfulRating`, `SmallInt` `1..5`).

### API & Atomic Compare-and-Set

[`POST /api/support/flow-outcomes/[id]/rating`](../../app/api/support/flow-outcomes/%5Bid%5D/rating/route.ts) authenticates the session (`requireApiSession`), enforces rate limiting (`spamLimiter` keyed on `flow-outcome-rating:${userId}`), validates `{ rating: 1..5 }` (`z.number().int().min(1).max(5)`), and calls [`rateFlowOutcome(outcomeId, userId, rating)`](../../lib/support/deflection.ts):

```ts
const updated = await prisma.supportFlowOutcome.updateMany({
  where: { id: outcomeId, userId, helpfulRating: null },
  data: { helpfulRating: rating },
});
```

- Returns `200 { data: { updated: true } }` on the first rating submission.
- Returns `409` if `updated.count === 0` (already rated, non-existent ID, or another user's outcome).

### Client Rendering & Low-Score Recovery

- **Platform scope ([`PlatformSupportSheet.tsx`](../../components/support/PlatformSupportSheet.tsx))**: `PlatformDoneView` renders a 1–5★ inline card on terminal self-serve resolutions (`done.resolved && !done.collectFeedback`), posting `{ rating }` to `/api/support/flow-outcomes/${done.outcomeId}/rating`.
- **Appointment scope ([`SessionConversation.tsx`](../../components/dashboard/shared/support/SessionConversation.tsx) & [`SupportRequestView.tsx`](../../components/dashboard/shared/support/SupportRequestView.tsx))**: `FlowRatingCard` renders 1–5★ when `t.isResolved && !t.isHuman`. A `useEffect` watching `t.lastOutcomeId` resets local `flowRating` state to `null` whenever a new terminal outcome arrives in the same thread.
- **Opt-in escalation on low scores (`<= 3`)**: Selecting a low rating (`<= 3`) surfaces a `"Get help"` / human-escalation action button without auto-filing a ticket, letting dissatisfied users describe their issue and escalate intentionally.

---

## 3. Half Two: Human Resolution CSAT (`SupportCase.csatRating`)

Human support satisfaction measures operator resolution quality on unified `SupportCase` rows (`SupportCase.csatRating`, `SupportCase.csatAt`) and pre-cutover legacy `SupportTicket` rows (`SupportCaseEvent` with `kind = 'CSAT_RATED'`).

### 24-Hour Delayed Survey Outbox Staging

When an operator transitions a case or legacy ticket to `RESOLVED` (including open child `INCIDENT` cases resolved via parent `PROBLEM` cascade in `patchSupportCaseLifecycle`), the transaction stages a delayed bell notification via `stageBell`:

- **Delay**: `notBefore = new Date(resolvedAt.getTime() + 24 * 3_600_000)` (24 hours after resolution so premature clicks do not race rapid follow-ups).
- **Idempotency key**: Deterministic `dedupeKey: csat:${id}:${resolvedAt.toISOString()}` prevents duplicate survey prompts across retries or re-resolutions with identical timestamps.

### Submission Window & Dual-Model CAS (`submitSupportCaseCsat`)

[`POST /api/support/cases/[caseId]/csat`](../../app/api/support/cases/%5BcaseId%5D/csat/route.ts) validates `{ rating: 1..5 }` and delegates to [`submitSupportCaseCsat`](../../lib/support/case-service.ts):

1. **Ownership & status check**: Caller must match `submitterUserId` (on `SupportCase`) or `userId` (on legacy `SupportTicket`), returning `404` otherwise. Target status must be `RESOLVED` or `CLOSED` (`400` otherwise).
2. **28-day survey window**: Enforces `now.getTime() - resolvedAt.getTime() <= 28 * 24 * 3_600_000` (`400` once expired).
3. **Single-write CAS guarantee**:
   - **Unified `SupportCase`**: `tx.supportCase.updateMany({ where: { id: caseId, status: { in: ["RESOLVED", "CLOSED"] }, csatRating: null }, data: { csatRating: rating, csatAt: now } })` paired with a `SupportCaseEvent` (`kind: "CSAT_RATED"`, `toValue: String(rating)`).
   - **Legacy `SupportTicket`**: Inserts `SupportCaseEvent` (`legacyTicketId: caseId`, `kind: "CSAT_RATED"`, `toValue: String(rating)`), backed by partial unique index `"support_case_event_legacy_csat_key"`; concurrent duplicate inserts raising Prisma `P2002` map cleanly to `409`.
4. **Customer UI**: `TicketCsatPrompt` in [`SupportRequestView.tsx`](../../components/dashboard/shared/support/SupportRequestView.tsx) renders on resolved requests within the 28-day window (`withinCsatWindow`) and invalidates the query cache upon `200 OK`.

---

## 4. Support Health Metrics (`supportHealthMetrics`)

[`GET /api/admin/support/health`](../../app/api/admin/support/health/route.ts) calls [`supportHealthMetrics(since, now)`](../../lib/support/deflection.ts) to power the admin backoffice overview in [`SupportHealthAndComplianceOverview.tsx`](../../components/dashboard/backoffice/support/SupportHealthAndComplianceOverview.tsx):

| Metric                      | Definition & Honesty Guard                                                                                                                                                                                                                                     |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deflectionRate`            | `resolved / (resolved + escalated)` across `SupportFlowOutcome` since `since` (`null` when zero terminal turns occurred).                                                                                                                                      |
| `recontactRate7d`           | Fraction of distinct self-serve resolved users (`firstResolvedByUser`) who produced any subsequent `SupportFlowOutcome`, active `SupportCase`, or `SupportTicket` within `(0, 7 days]`. Paired directly with `deflectionRate` so silent drop-offs are visible. |
| `ackWithin24hRate`          | Percentage of evaluated cases/tickets acknowledged within 24h of `createdAt`. Denominator includes every acknowledged row **plus any unacknowledged row older than 24 hours (`createdAt <= now - 24h`)**, counting overdue unacknowledged cases as misses.     |
| `disposedWithin15dRate`     | Percentage of resolved cases/tickets where `resolvedAt - createdAt - pausedSeconds * 1000 <= 15 days` (IT Rules 2021 Rule 3(2) statutory disposition window net of customer wait pauses).                                                                      |
| `medianFirstReplyMinutes`   | Median wall-clock minutes from `createdAt` to `firstAgentReplyAt` across human-replied cases/tickets.                                                                                                                                                          |
| `csatAverage` / `csatCount` | Mean (`2` decimal places) and count of non-null `SupportCase.csatRating` scores in the window (`null` when `csatCount === 0`).                                                                                                                                 |

### Why `NULL` Must Stay Distinct From `1`

Both `SupportFlowOutcome.helpfulRating` and `SupportCase.csatRating` default to `NULL` and remain `NULL` whenever a customer skips the prompt. Treating an unanswered prompt as `1` (or `0`) would conflate silent non-response with active dissatisfaction, mirroring the opposite error of counting abandoned self-serve flows as happy resolutions. All analytics queries filter strictly on `rating !== null` prior to averaging, and empty cohorts return `null` rather than `0`.

---

## Related

- [05-schema-reference.md](05-schema-reference.md) — `SupportFlowOutcome`, `SupportCase`, and `SupportCaseEvent` schema definitions and partial indexes.
- [03-ticket-references-and-sla.md](03-ticket-references-and-sla.md) — statutory IT Rules 2021 acknowledgement (`24h`) and disposition (`15d`) clocks.
- [`docs/feedback/`](../feedback/README.md) — consultation/session quality ratings (`AppointmentFeedback`), separate from support CSAT.

---

## Deprecated & Superseded Approaches

> [!NOTE]
> Retain these retired designs strictly as guardrails against reviving superseded approaches.

- **Dormant `helpfulRating` column without prompt & missing human case CSAT**:
  - Replaced by inline 1–5★ rating cards (`rateFlowOutcome`) and 28-day case CSAT (`submitSupportCaseCsat`).
- **Raw `deflectionRate` without `recontactRate7d` or `> 24h` unacknowledged misses**:
  - Replaced by paired `recontactRate7d` and `createdAt <= now - 24h` denominator inclusion.
- **Mismatched `{ helpfulnessRating }` / `{ csatRating }` client payloads**:
  - Replaced by unified `{ rating: 1..5 }` across both rating endpoints.
- **Secondary `findFirst` lookup after `recordFlowOutcome`**:
  - Replaced by `recordFlowOutcome` returning `Promise<string | null>` (`outcomeId`) directly.
