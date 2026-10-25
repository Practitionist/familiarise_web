# How money changes are verified

State exactly which evidence exists: mocked behavior, disposable database behavior, read-only vendor/database observations, or an authorized end-to-end transaction. Passing tests does not establish that a deployment received a webhook, drained a backlog, or delivered an alert. An agent's summary and a green HTTP response are claims to check against the code and the committed effects.

## Implementation checks

Use focused Jest tests with mocked vendor boundaries to exercise claims, retries, duplicate delivery, transaction rollback and failure after partial progress. Test invariants that matter to the active flow rather than mirroring implementation details. A regression should fail against the unsafe behavior; a temporary negative control is useful when validating a concurrency fix.

Polling fairness needs repeated runs with a slow first candidate, not only fast failures. An attempted gateway timeout must rotate without marking provider reconciliation successful; a candidate skipped before its request starts must stay unstamped. Advance the test clock through the full execution budget and verify later candidates are reached on subsequent invocations.

Use the guarded database tier for real PostgreSQL interleavings. It accepts only a disposable localhost `/ci` database with `CI=true`. A one-connection local pool can exercise transaction-client discipline; pass `tx` through every helper and refuse global Prisma reads inside the transaction. Deploy previews additionally verify host packaging, request limits, cold starts and runtime behavior. Never run `next dev`, an application build, or a shared-database write without the session's authorization.

## Shared data and read-only observations

The Supabase project is shared across dev, production and worktrees. Environment labels and Razorpay test credentials do not isolate its tables. Do not assume every existing row is a fixture because some IDs or emails look like QA data. Record the queried environment, provider merchant/mode, cutoff and identifiers needed to reproduce an observation; avoid printing credentials or personal payloads.

Safe observations include scoped SELECTs through the read-only Supabase MCP (nothing is mutated through MCP), database constraint/index catalogs and provider GETs. A provider object read under test credentials proves only what that configured merchant can see. A missing or inconsistent object is not proof that another merchant has no liability. Jobs that write an execution lease, reconciliation report, marker, outbox or freeze are mutations even when called auditors; do not invoke them against shared data as a read-only probe.

## Razorpay MCP is opt-in and write-capable

The shared `.mcp.json.example` does not include Razorpay. To use the remote,
copy `.mcp.razorpay.example.json` to the gitignored `.mcp.razorpay.json` and
start the session with `claude --mcp-config .mcp.razorpay.json` (or merge the
`rzp-mcp-server` block into `.mcp.json`). The credential lives in the gitignored
`.mcp.razorpay.headers` (one `Authorization: Basic <token>` line, `chmod 600`),
which `mcp-remote --header-file` reads so the token never appears in the process
list. The relative path resolves against the session's working directory, so start
the session from the repository root. The remote exposes order, capture and
refund tools and has no read-only mode; use a test-mode key and never production
credentials.

## SQL and deployment gates

Use Prisma's physical table/column mapping when writing SQL. `Organization` maps to `organizations`; a correct model name in TypeScript is not a SQL relation name. Before shipping an additive rollout artifact, check it against a pinned base schema and the changed schema in a disposable database. Apply it twice to verify idempotency, compare the resulting schema read-only, and test the DML statement it supports. Preserve retention and polling clocks when updating housekeeping metadata.

Shared drift checks remain read-only: `npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script`. SQL application is a separate operator-controlled action. Never run `prisma db push` or an `npm run db:*` command autonomously; sidecar constraints and partial uniques must survive deployment.

## Authorized end-to-end verification

Prepare the exact scenario, expected effects and identifiers before requesting the final authorization for a real mutation. Use an approved fixture and approved gateway mode, record every created ID, and distinguish a staging obligation from delivery and settlement. No general instruction to investigate or test authorizes a real capture, refund, payout, retention sweep or schema operation.

For an authorized run, follow the complete causal chain:

- Gateway evidence matches the payment/order/refund identity and configured merchant.
- Payment and booking state moved through the canonical confirmer or refund rail using the expected prior-state claim.
- Expected journal, earnings, invoice/credit-note and utilization effects committed together. Database-enforced balance, currency and funding constraints remain the enforcers; do not add a JavaScript sweep to re-check them.
- Email and notification obligations were staged with the business change and delivery used the existing guard. An accepted request is not proof of delivery.
- Reconciliation produced the expected completed scoped verdict. An attempt, an incomplete RUNNING report or a shared heartbeat does not prove that the audit finished or the backlog drained.

Cleanup is reviewed separately. Never delete posted ledger rows to tidy up a test. Report outstanding obligations and any failed or held result explicitly.

## Deprecated & Superseded Approaches

Earlier guidance treated a deploy preview and test gateway keys as sufficient isolation and assumed the shared dataset was entirely disposable. Neither assumption is a safe authorization boundary. Preview checks still matter for host behavior, while guarded local PostgreSQL tests establish database interleavings without shared residue. Historical assertions that single-connection failures reproduce only on a deployed host should not prevent a focused local pool test.

## Sources

`AGENTS.md`, `__tests__/db/guard.ts`, `lib/prisma.ts`, `prisma/schema.prisma`, `prisma/sql/reconciliation-cursors.sql`, `docs/maintenance/10-cron-and-reconciliation-reference.md`, `docs/finance/70-operations/07-go-live-checklist.md`, and the owning domain’s fixtures and worker implementation.
