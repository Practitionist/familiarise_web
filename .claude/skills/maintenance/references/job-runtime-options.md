# Job-runtime options: measured facts, footguns and reruns

Evidence from 2026-10-31, not decisions. Depth, diagrams and sources: `docs/maintenance/14-background-job-runtime-options.md`. Raw logs: `docs/maintenance/experiments/2026-10-31-job-runtime/`. The decisions are in `docs/decisions/2026-10-31-ticker-scale-path-and-queue.md`: keep the ticker through launch, trial Vercel `bom1`, no hosted job service, and a hand-written Prisma `Job` table for phase 2. Do not add a second scheduler beside the ticker (`AGENTS.md` rule 4).

## Decision-relevant facts

- Only code that runs in Mumbai removes the per-statement cost. Netlify Singapore is 62-64 ms per statement with raw `pg` (about 95 ms measured through the app earlier; Prisma adds 0.1 ms or less per statement, so the gap is unexplained), Trigger.dev Frankfurt 125 ms, `bom1` 1.0-2.1 ms.
- Hosted schedulers (Inngest, QStash, Upstash Workflow) call our route. The compute stays on Netlify and keeps its limits. Trigger.dev runs the code itself, but only in `eu-central-1`, `us-east-1` or `us-west-2`.
- pg-boss and DBOS keep the queue in Postgres and enqueue in the caller's transaction (rollback leaves 0 jobs). They need a long-lived worker, which Netlify functions are not.
- Vendor side effects are at-least-once on every runtime. Idempotency keys, CAS-in-WHERE and the reconcilers stay.
- Running on a remote host does not make the transaction distributed. It holds locks longer: a 10-round-trip hold is about 690 ms on Netlify, 1,258 ms from Frankfurt, 395 ms from the laptop, 10.6-19.6 ms on `bom1`.
- Static egress for RazorpayX is solved on Netlify by `RAZORPAYX_EGRESS_PROXY_URL` (`apiRequest` in `lib/payments/payouts/razorpay-payouts.ts`).

## Measured numbers

| Runtime                                          | Round trip                                     | 10-trip lock hold    | Notes                                |
| ------------------------------------------------ | ---------------------------------------------- | -------------------- | ------------------------------------ |
| Netlify Singapore, raw `pg`                      | 62-64 ms                                       | 676-707 ms           | connect 371-405 ms                   |
| Trigger.dev eu-central-1 / us-east-1 / us-west-2 | 125 / 185 / 232 ms                             | 1,258 ms (Frankfurt) | no region given lands in us-east-1   |
| Vercel `bom1`, raw `pg`                          | 1.0-2.1 ms                                     | 10.6-19.6 ms         | Hobby cap 300 s, `*/5` cron rejected |
| Laptop India                                     | 39.5 ms                                        | 395 ms               | best case only                       |
| QStash EU to Netlify                             | publish-to-receive median 1,366 ms (p95 2,115) | n/a                  | 30 s function: 504, 3 side effects   |

With Fluid compute ON, warm bursts of 20 and 50 requests used 7 and 13 instances where OFF used 20 and 50 (one request per instance), at the same latency. Vercel Workflows steps run in our `bom1` functions at 2.3-3.2 ms per query. QStash EU to `bom1`: publish-ack to handler about 350 ms.

A user update to a row locked from Frankfurt waited about 1.1 s against 37.6 ms with no job. SERIALIZABLE lost one of every concurrent pair (40001) in both places, so keep `withSerializableRetry` (`lib/db/serializable-retry.ts`).

## Footguns

- DBOS needs a pool of about 10 or more. With `systemDatabasePoolSize: 2` its advisory-lock connection hits the 5 s idle-in-transaction timeout and the process crashes. It cannot run under `PG_POOL_MAX=1`. Pin `DBOS__APPVERSION`, or a non-latest worker stops dequeuing.
- pg-boss can fire a duplicate cron job in the first minute after `schedule()` (2 of 2 Supabase runs). Recovery after `kill -9` takes about 65 s (60 s monitor floor); its concurrency limit is per process; LISTEN/NOTIFY needs both the instance flag and `notify: true` per queue.
- The Upstash Workflow handler re-runs from the top on every request (4 requests, 8 handler executions for a 3-step run), while each `context.run` body runs once. Keep everything with side effects inside `context.run`.
- QStash retries a 504 even though the function keeps running. One 30 s message wrote 3 side effects, retries at about 12 s, 160 s and 33 min. Ack fast, verify the signature, make the handler idempotent.
- Inngest remote sync needs a manual PUT with `x-inngest-sync-kind: in_band` against a dev server. The dev server polls the site every 5 s, and each poll is a billed invocation. Checkpointing `maxRuntime` is checked between steps only; set it below the host limit minus the longest step.
- Inngest `connect` is unsupported on serverless runtimes (official docs).
- The Netlify real edge cut is about 30 s on a throwaway site but about 26 s measured on prod. Design for 26 s.
- Trigger.dev Free uses dynamic egress IPs. Static IPs are paid-only; the plan tier is UNVERIFIED.
- Vercel `"fluid": false` in `vercel.json` did not take effect; only `PATCH /v9/projects/<name>` with `resourceConfig.fluid` flipped it.
- Upstash Workflow `context.call` to an endpoint that returns 504 still ends the step `STEP_SUCCESS` and the run `RUN_SUCCESS`. Always check `res.status`.
- QStash to Vercel: a 310 s target gets a 504 at 300 s, retries after 11 s and about 141 s, then the DLQ. A function that already returned 504 still finishes its write (zombie), so handlers must be idempotent.
- Vercel Workflows `start()` is not part of our Postgres transaction: `start()` then `ROLLBACK` ran a workflow for a missing order. Use an outbox.
- A publish after commit is a dual write. Use state as the outbox or an in-database enqueue.

## How to rerun a probe

Scripts live outside the repo; the Inngest, pg-boss, DBOS, Supabase and Trigger.dev ones are stored as text in `docs/maintenance/experiments/2026-10-31-job-runtime/source-code.md`. The second Vercel round is in `vercel-fluid-prisma-qstash-workflows.md` (code not kept). The Vercel probe is described in `docs/maintenance/experiments/2026-10-31-job-runtime/vercel-bom1-latency.md`. The lock-hold, Netlify and QStash scripts were not kept.

1. Make a scratch directory outside the repo and copy the script out of the markdown.
2. Pass the database address through an environment variable only. Use a throwaway `lab_` schema on the shared project.
3. For Vercel, pin `regions: ["bom1"]`; for Netlify, set the site `functions_region` to `ap-southeast-1` and confirm it inside the function. Check `VERCEL_REGION` or `AWS_REGION`.
4. Run, then drop the schema, delete env vars and delete the throwaway site or project. Record versions and the cleanup proof in the report.
5. Never print or commit a connection string, token or the laptop address.
