# Outbound webhooks

PR #655 introduces per-organization outbound webhook endpoints so that
external integrations (HRIS, finance ERP, customer-success tools) can
react to lifecycle events without polling the dashboard or scraping the
audit-log export.

## Event catalog

The catalog is closed. Adding a new event requires the corresponding
emit-point + a doc update; renaming an event is a breaking change to
every receiver.

| Event | Triggered from | Payload highlights |
|---|---|---|
| `member.added` | `POST /api/organizations/[orgId]/members` (in-app invite accept) AND SCIM upsert (Batch 4) | `{ membershipId, userId, role, departmentLabel }` |
| `member.removed` | `DELETE /api/organizations/[orgId]/members/[memberId]` AND SCIM deprovision | `{ membershipId, userId, role, previousStatus }` |
| `invoice.issued` | `POST .../billing-account/invoices` when `issueImmediately=true` | `{ invoiceId, invoiceNumber, totalPaise, displayCurrency, dueDate, purchaseOrderId?, contractId? }` |
| `invoice.paid` | Razorpay payment webhook flips invoice status to `PAID` | `{ invoiceId, invoiceNumber, paidPaise, paymentId, settledAt }` |
| `payout.completed` | RazorpayX `payout.processed` webhook → status PAID | `{ payoutId, totalPaise, currency, payoutReference, settledAt }` |
| `payout.failed` | RazorpayX `payout.failed` OR `payout.reversed` webhook | `{ payoutId, reason, lastError }` |
| `contract.signed` | Contract status transition `DRAFT → ACTIVE` | `{ contractId, status, effectiveFrom, totalAmountPaise? }` |
| `program.assigned` | `ProgramAssignment.create` (in-app + SCIM-driven) | `{ programId, membershipId, periodStart, periodEnd }` |

## Receiver contract

Every delivery is a `POST` with `Content-Type: application/json` and:

```
X-Familiarise-Signature: t=<unix-seconds>,v1=<sha256-hex>
User-Agent: Familiarise-Webhooks/1.0
```

Body shape:

```json
{
  "id": "del_xxxx",        // OutboundWebhookDelivery.id
  "type": "invoice.issued",
  "createdAt": "2026-05-15T10:00:00.000Z",
  "data": { ... event-specific payload ... }
}
```

The `id` field is **the** idempotency key. Receivers MUST store the IDs
they've already processed and skip duplicates — our retry schedule WILL
deliver the same `id` more than once if your endpoint responds with 5xx
or times out.

## Signature verification

The signature scheme mirrors Stripe's (`t=<unix>,v1=<hex>`) so any
language with HMAC-SHA256 + a string concat + a constant-time compare
can verify in <20 lines.

Reference implementation (Node):

```ts
import { createHmac, timingSafeEqual } from "node:crypto";

const REPLAY_WINDOW_SECONDS = 9 * 60 * 60; // match producer

function verify(secret: string, body: string, header: string): boolean {
  const t = header.split(",").find(p => p.startsWith("t="))?.slice(2);
  const v1 = header.split(",").find(p => p.startsWith("v1="))?.slice(3);
  if (!t || !v1) return false;
  if (Math.abs(Date.now() / 1000 - Number(t)) > REPLAY_WINDOW_SECONDS) return false;
  const expected = createHmac("sha256", secret).update(`${t}.${body}`).digest();
  const received = Buffer.from(v1, "hex");
  if (received.length !== expected.length) return false;
  return timingSafeEqual(received, expected);
}
```

The replay window must be **at least 9 hours** because our retry
schedule (1m / 5m / 30m / 2h / 8h) means the same signature can land at
+8h after creation. A receiver with a tighter window will mis-reject
late retries.

## Retry semantics

Worker schedule (`lib/enterprise/outbound-webhooks/worker.ts`):

| Attempt | Wait before next | Cumulative wall-clock |
|--------:|------------------|-----------------------|
| 1 | 1m | 1m |
| 2 | 5m | 6m |
| 3 | 30m | 36m |
| 4 | 2h | 2h 36m |
| 5 | 8h | 10h 36m |
| 6 (final) | — | FAILED |

Permanent client errors (`400`, `403`, `404`, `410`, etc., excluding
`408` and `429`) skip the retry queue — the receiver told us the
request is malformed and re-sending the same body won't change the
outcome. `408 Request Timeout` and `429 Too Many Requests` are
considered transient.

## API gate matrix

See `docs/enterprise/03-roles-and-permissions.md` for the canonical
table. Quick view:

| Verb | Path | Gate |
|---|---|---|
| `GET` | `/webhooks` + `/[endpointId]` + `/deliveries` | MANAGER+ |
| `POST` | `/webhooks` (create) | OWNER + BILLING_ADMIN |
| `PATCH` | `/webhooks/[endpointId]` | OWNER + BILLING_ADMIN |
| `POST` | `/webhooks/[endpointId]/deliveries/[deliveryId]/redeliver` | OWNER + BILLING_ADMIN |
| `POST` | `/webhooks/[endpointId]/rotate-secret` | OWNER only |
| `DELETE` | `/webhooks/[endpointId]` | OWNER only |

The OWNER-only floor on `DELETE` and `rotate-secret` is deliberate —
both actions are destructive from the integrator's perspective
(deletion cascade-drops pending deliveries; rotation invalidates the
receiver's existing verification code until they update the secret).

## Local integration testing

The fastest path to a green receiver:

1. Open https://webhook.site and copy the unique URL.
2. `curl -X POST $BASE/api/organizations/$ORG/webhooks -H "Cookie: $OWNER_COOKIE" -H "Content-Type: application/json" -d '{"url":"<webhook.site URL>","eventSubscriptions":["invoice.issued"]}'`
3. Note the returned `secret` — copy it into webhook.site's "Edit response" if you want to test signature verification, or keep it for the next step.
4. Issue an invoice with `issueImmediately=true`.
5. Wait for the next cron tick (≤1 min) or trigger it manually:
   `curl -X POST $BASE/api/cleanup/dispatch-outbound-webhooks -H "Authorization: Bearer $CRON_SECRET"`
6. Verify webhook.site shows the delivery + the `X-Familiarise-Signature` header.

## Rate limits

- `orgWebhookLimiter` — 5 per minute per org for POST/PATCH/rotate-secret. Org-keyed.
- Worker per-endpoint host throttle is governed by the `MAX_BATCH` constant in `worker.ts` (50) and the worker's tick cadence (1 minute). A single endpoint cannot receive more than 50 deliveries per minute.

## Audit trail

Every CRUD action and every delivery final state writes to
`OrgAuditLog` under the `WEBHOOK` category:

- `WEBHOOK_ENDPOINT_CREATED|UPDATED|DELETED|SECRET_ROTATED|PAUSED|RESUMED`
- `WEBHOOK_DELIVERY_SUCCEEDED|FAILED|REDELIVERED`

Filter for these in the audit-log export when investigating
integrator-reported issues.
