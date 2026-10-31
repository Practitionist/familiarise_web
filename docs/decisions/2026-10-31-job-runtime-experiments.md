# ADR: Job-runtime experiments (evidence record)

- **Status**: Evidence, no new owner decision. Nothing in this record changes a decision taken in the ticker ADR or the at-scale review. One detail is still unverified: which Trigger.dev paid plan includes static IPs.
- **Date**: 2026-10-31
- **Author**: Platform engineering
- **Related**: [Ticker through launch, the scale path, the phase 2 queue and the database plan](2026-10-31-ticker-scale-path-and-queue.md), [Architecture at scale review](2026-10-30-architecture-at-scale-review.md), [Background-job runtime options](../maintenance/14-background-job-runtime-options.md), [the raw reports](../maintenance/experiments/2026-10-31-job-runtime/README.md), issues #2472, #2484, #2485

## Context

The owner asked whether a hosted job engine or a Postgres queue library would change the picture drawn by the ticker ADR. That ADR decided to keep the Netlify ticker through launch, to trial Vercel `bom1` before about 300 concurrent users, to adopt no hosted job service and to write the phase 2 queue by hand as a Prisma `Job` table. Four experiments tested the claims behind those decisions on the real libraries and, for Trigger.dev and Supabase, on the real services.

## Evidence

The table gives each finding, the decision it bears on and which way it points.

| Finding                                                                                                                                                                                                                                 | Bears on           | Direction                                                       |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | --------------------------------------------------------------- |
| Inngest POSTs to our `serve()` route. On Netlify that is a normal Next.js function, so the host limit and the Singapore round trip are unchanged.                                                                                       | Decision 3         | Strengthens "no hosted service".                                |
| A 40 s step behind a 26 s edge 504 failed on every retry. `checkpointing.maxRuntime` (default 10 s) splits a sequence of short steps, never one long step.                                                                              | Decision 3         | Strengthens.                                                    |
| Side effects ran three times with checkpointing off, and once concurrently in an overlap case.                                                                                                                                          | Idempotency rules  | Confirms at-least-once.                                         |
| Trigger.dev Cloud runs our code in `us-east-1`, `us-west-2` or `eu-central-1` only. Round trips to the Mumbai pooler: about 125, 185 and 232 ms, against about 95 ms from Netlify.                                                      | Decision 3         | Strengthens, and corrects the wording.                          |
| Trigger.dev Free uses dynamic egress IPs. Static IPs are paid-only per its changelog; which paid plan, how many IPs and any price are UNVERIFIED.                                                                                       | RazorpayX egress   | Unverified detail.                                              |
| pg-boss and DBOS both enqueue inside the caller's transaction and both work through the Supabase 6543 and 5432 poolers.                                                                                                                 | Decision 4         | Shows an alternative is viable.                                 |
| DBOS crashed with a pool of 2 and was stable at 10. Its LISTEN/NOTIFY fails on 6543 and it polls.                                                                                                                                       | Decision 4         | Weakens DBOS on small pools.                                    |
| pg-boss fired a duplicate cron job in the first minute after `schedule()` in 2 of 2 Supabase runs, and its concurrency limit is per process.                                                                                            | Decision 4         | Weakens pg-boss for exact-once schedules.                       |
| After `kill -9`, DBOS resumed the interrupted step in about 3 s with one side effect. pg-boss reran the whole job after about 65 s with two.                                                                                            | Decision 4         | Shows what a hand-written queue must beat.                      |
| pg-boss has a free dashboard; DBOS's UI and MCP server need the paid Conductor.                                                                                                                                                         | Operations console | Neutral.                                                        |
| A 10-round-trip lock hold lasts 1,258 ms from Frankfurt and 395 ms from a laptop. An update to the locked row waited about 1.1 s, against 37.6 ms with no job. Two concurrent Serializable copies lost one of each pair in both places. | Decisions 2 and 3  | Strengthens: distance lengthens every lock and snapshot window. |

Two conclusions the experiments do not support:

- That any of these options is faster than Netlify for database-heavy jobs. Only a host in Mumbai removes the per-statement cost, and none of the four tested runtimes supplies one.
- That a hosted engine removes the need for idempotency keys, compare-and-swap writes and the reconcilers.

## Effect on the existing decisions

- **Decision 1 (ticker through launch).** Unchanged and strengthened. No tested option replaces the ticker's compute.
- **Decision 2 (Vercel `bom1` trial).** Untested. Nothing here ran on Vercel.
- **Decision 3 (no hosted job service).** Unchanged. One wording correction is proposed for the owner's approval: the ADR says every listed service calls back into our functions, but Trigger.dev runs the code itself. The reason to reject it is the same, because its nearest region is slower than Singapore.
- **Decision 4 (a hand-written Prisma `Job` table).** Unchanged. If it is built, the experiments list three behaviours it should have, whichever way it is written: reclaim a crashed claim within a minute or two, enforce a global concurrency limit, and tolerate a duplicate start.

## Open questions for the owner

1. Is the single always-on Mumbai VM in #2484 (about $24 a month, with a static IP) in scope? The ticker ADR rejected the $100 to $440 container plan on cost. It did not consider a VM of this size. The experiments show that Inngest Connect, pg-boss and DBOS all need a long-lived process, which a VM provides.
2. Is a Trigger.dev sales or support question about static IPs worth asking? Paid-only is confirmed, the plan tier is not. The RazorpayX proxy decision (F1) already covers Netlify, so this matters only if Trigger.dev were ever adopted.
3. Should the Decision 3 sentence be corrected to say that Trigger.dev runs code on its own machines?
4. The lock-hold measurement is in. Should a remote worker (any host more than about 100 ms from the database) be barred from holding locks on booking rows, or kept to short transactions? The existing guards (`withSerializableRetry`, CAS-in-WHERE) are unchanged.

## Consequences

- No code or schedule changes follow from this record.
- The raw reports stay in `docs/maintenance/experiments/2026-10-31-job-runtime/`. New measurements are appended there and summarised in the explanation page.

## Deprecated & Superseded Approaches

None. This record adds evidence only. If an owner decision follows, it supersedes the open questions above.
