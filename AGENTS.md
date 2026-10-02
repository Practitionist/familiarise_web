# Familiarise Web — Agent Architecture & Anti-Over-Engineering Rules

> Canonical instructions for all AI coding agents (`CLAUDE.md` is a symlink to `AGENTS.md`).
> Read domain skills under `.claude/skills/<domain>/SKILL.md` on demand; **this root file overrides any conflicting style or wrapper convention in `.claude/`.**

## 1. Anti-Over-Engineering Rules (Strictly Enforced)

1. **No 3-Layer Cron/Script Wrappers**:
   - Never create parallel `scripts/<domain>/<job>.ts` + `jobs/<domain>/<job>.ts` + `app/api/cleanup/<job>/route.ts` files.
   - A background job has **one** implementation function registered in `lib/cron/cleanup-registry.ts` (dispatched via `/api/cleanup/[job]` and `/api/admin/system-jobs/run`). Do not add new `GITHUB_OUTPUT` wrapper scripts under `jobs/**` or `scripts/**`.
2. **No Speculative Abstractions, Flags, or State Machines**:
   - Do not add feature flags, env-var tuning knobs, fallback dual-reads, or multi-step state machines unless required by an active user flow today.
   - Delete dead code and unused exports outright; never keep `@deprecated` re-exports or "back-compat" shims for internal callers.
3. **No JS Reconcilers for Postgres-Enforced Invariants**:
   - Before writing a reconciliation check or runtime assertion, check `prisma/sql/{check-constraints,ledger-triggers,payment-legs-triggers}.sql`.
   - If a Postgres `CHECK` constraint, `EXCLUDE USING gist` index (`slot_no_confirmed_overlap`), or `CONSTRAINT TRIGGER` (`ledger_balance_check`, `payment_legs_sum_to_amount`, `ledger_*_immutable`) already prevents an invalid state at `COMMIT`, **do not** write application-level sweeps to re-verify it. Only reconcile across external vendor boundaries (Razorpay, Stream, Resend, Supabase Storage).
4. **No Dual Schedulers by Default**:
   - Latency-sensitive recovery sweeps run on the 5/15-min Netlify ticker (`netlify/functions/cron-tick.mts` -> `/api/cleanup/[job]?limit=N`). Daily/weekly batch jobs run in GitHub Actions. Do not add both a sub-hourly GHA workflow and a Netlify ticker entry for the same job unless explicitly requested.
5. **No Ticket-Number Archaeology in Code Comments**:
   - **NEVER** write multi-paragraph docblocks or inline comments citing historical PR/issue numbers (`#1234`, `FIX #568`, `P1-W02a`, `owner decision Q3`) or narrating what old deleted code used to do.
   - Comments must state **only** the current invariant or non-obvious runtime constraint in 1–2 concise lines. Git blame owns history.

## 2. Core Runtime & Database Invariants

1. **`PG_POOL_MAX=1` (No Global Prisma Reads Inside `$transaction`)**:
   - Serverless functions run with a 1-connection pool. Inside `prisma.$transaction(async (tx) => ...)`, **every** helper call must receive and query `tx`, never the global `prisma` client (which deadlocks waiting for the single connection).
2. **Money & State Transitions**:
   - All money columns are `BigInt` paise in Postgres (mapped to `number` at the Prisma client boundary in `lib/prisma.ts`). Settlement is INR-only.
   - Every status transition on `Payment`, `Appointment`, `Refund`, or `Payout` must use conditional `updateMany` with the expected prior status in `WHERE` (CAS-in-WHERE), never read-then-update.
   - `Payment.paymentStatus = SUCCEEDED` is written only by the payment confirmation pipeline (`lib/payments/webhooks/handlers.ts`).
3. **Schema & Sidecar Discipline (`prisma/schema.prisma` + `prisma/sql/*.sql`)**:
   - One Postgres database serves dev and prod across worktrees. **Never** run `prisma db push` or `npm run db:*` autonomously.
   - Check live-DB drift read-only with `npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script`; a plain `db push` would drop the `prisma/sql` sidecar uniques.
   - Run `npx prisma generate` after editing `prisma/schema.prisma`. Any new `CHECK`, partial unique index, or trigger belongs in `prisma/sql/*.sql`.
4. **Locking (`Postgres` vs `Upstash Redis`)**:
   - Cron mutual exclusion (`withCronLock` in `lib/cron/with-cron-lock.ts`) is backed by Postgres (`SystemJobExecution` lease). Do not add Redis locks for cron jobs.
   - Upstash Redis (`lib/redis.ts`, `lib/rate-limit.ts`, `utils/appointmentlock.ts`) is used only for request rate limiting, maintenance-mode edge state, and short-lived interactive checkout/payout mutexes.

## 3. Cloudtop Worktree & Dependency Hygiene

1. **Single Canonical `node_modules`**:
   - In secondary git worktrees, always symlink the main checkout's `node_modules` (`ln -s <main-checkout>/node_modules node_modules`) and remove the worktree cleanly when finished. Never run standalone `npm ci` copies across worktrees.
2. **Minimum Patched Versions**:
   - Never downgrade `next` (`>= 15.5.27`) or `sharp` (`>= 0.35.5`).
3. **Verification Commands**:
   - Typecheck: `npx tsc --noEmit`
   - Lint: `npm run lint` (errors fail CI; warnings are advisory)
   - Format check: `npm run format:check`
   - Targeted Jest test: `npx jest path/to/test.ts` (never run `next dev`, `next build`, or `db:push` unless instructed).

## 4. Engineering Practices

1. Never add `eslint-disable*`, `@ts-ignore`, `@ts-expect-error` or `@ts-nocheck`; fix the code. If a rule is wrong for a path, turn it off for that path in `eslint.config.mjs` with a one-line reason.
2. List every effect dependency; never suppress `react-hooks/exhaustive-deps`. Never write `ref.current` during render — React is 18.3 (no `useEffectEvent`), so sync latest-value refs in an effect declared before the one that reads them.
3. Never capture to Sentry per row inside a loop or sweep; collect failures and report once per run. All errors share the free plan's 5,000/month quota.
4. Email: every send goes through `deliver()`, or for the waitlist broadcast batch through `heldRecipientDomain()`, so the pre-launch guard (`EMAIL_DELIVERY_MODE`) sees every recipient; see `docs/email/README.md`.
