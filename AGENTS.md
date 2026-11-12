# Familiarise Web — Agent Rules

> Canonical instructions for every AI coding agent. Each `CLAUDE.md` is only `@AGENTS.md` (an import of the `AGENTS.md` beside it); never put content in a `CLAUDE.md`.
> Directory rules live in nested `AGENTS.md` files (`lib/cron/`, `lib/payments/`, `lib/booking/`, `prisma/`, `docs/`). Read the nearest one before editing there; Claude Code loads it when it first reads a file in that directory.
> Domain playbooks are skills under `.claude/skills/<domain>/SKILL.md`, read on demand. **This root file overrides any conflicting style or wrapper convention in `.claude/`.**

## 1. Anti-Over-Engineering Rules (Strictly Enforced)

1. **No 3-Layer Cron/Script Wrappers**: a background job has **one** implementation function registered in `lib/cron/cleanup-registry.ts`. Never add parallel `scripts/<domain>/<job>.ts`, `jobs/<domain>/<job>.ts` or `app/api/cleanup/<job>/route.ts` files, or new `GITHUB_OUTPUT` wrappers. Details: `lib/cron/AGENTS.md`.
2. **No Speculative Abstractions, Flags, or State Machines**:
   - Do not add feature flags, env-var tuning knobs, fallback dual-reads, or multi-step state machines unless required by an active user flow today.
   - Delete dead code and unused exports outright; never keep `@deprecated` re-exports or "back-compat" shims for internal callers.
3. **No JS Reconcilers for Postgres-Enforced Invariants**: before writing a reconciliation check or runtime assertion, read `prisma/AGENTS.md` and the hand-written migrations in `prisma/migrations/`. Only reconcile across external vendor boundaries (Razorpay, Stream, Resend, Supabase Storage). Booking-overlap limits, which also bind `lib/appointments/` and `utils/scheduling-engine/`: `lib/booking/AGENTS.md`.
4. **No Dual Schedulers by Default**: every scheduled job runs on the one ticker, gated by `ops:active_cron_platform`; no second scheduler and no GitHub Actions schedule for a registry job. Details, which also bind `app/api/cleanup/`, `app/api/admin/system-jobs/` and `netlify/functions/`: `lib/cron/AGENTS.md`.
5. **No Ticket-Number Archaeology in Code Comments**:
   - **NEVER** write multi-paragraph docblocks or inline comments citing historical PR/issue numbers (`#1234`, `FIX #568`, `P1-W02a`, `owner decision Q3`) or narrating what old deleted code used to do. The `Release checks` workflow (`scripts/ci/check-comment-archaeology.ts`) fails comment lines added since `prod` that cite a ticket number, a planning id or "owner decision"; narrated history is caught in review, not by CI.
   - Comments must state **only** the current invariant or non-obvious runtime constraint in 1–2 concise lines. Git blame owns history.

## 2. Core Runtime, Database & Multi-Host Portability Invariants

1. **Serverless Single-Connection Pool (`PG_POOL_MAX=1` on Lambda/Netlify — Never Global Prisma Reads Inside `$transaction`)**:
   - Single-invocation serverless runtimes (`NETLIFY=true`) run with `PG_POOL_MAX=1`, while multi-request runtimes (`Cloud Run` / `Vercel Fluid` / `Fly`) share a bounded pool (`PG_POOL_MAX=5..10`). Inside `prisma.$transaction(async (tx) => ...)`, **every** helper call must receive and query `tx`, never the global `prisma` client (which deadlocks under `PG_POOL_MAX=1`).
2. **Money & State Transitions**:
   - All money columns are `BigInt` paise in Postgres (mapped to `number` at the Prisma client boundary in `lib/prisma.ts`). Settlement is INR-only.
   - Every status transition on `Payment`, `Appointment`, `Refund`, or `Payout` must use conditional `updateMany` with the expected prior status in `WHERE` (CAS-in-WHERE), never read-then-update. Payment confirmation rules: `lib/payments/AGENTS.md`.
3. **Every Schema Change Is a Migration (`prisma/schema.prisma` + `prisma/migrations/`)**:
   - A schema change is a new `prisma/migrations/<timestamp>_<name>/migration.sql`, wrapped `BEGIN; SET LOCAL lock_timeout = '3s'; … COMMIT;`, in the same PR as the schema and code. Never edit an applied migration. Procedure: `.claude/skills/schema/references/multi-session-workflow.md`.
   - One Postgres database serves dev and prod across worktrees, and `db-migrate.yml` applies a merged migration to it on the push to `dev`, so a merge must be expand-only; destructive changes go in a `_contract` folder the owner dispatches. **Never** run `prisma db push`, `migrate dev`, or `migrate deploy`/`resolve`/`reset` against the shared database; generate and test against a local Postgres 17 cluster in UTC.
   - Run `npx prisma generate` after editing `prisma/schema.prisma`. Everything else: `prisma/AGENTS.md`.
   - Supabase MCP: reads run freely, several batched into one `execute_sql` call. Every write or DDL needs the owner's approval in the session, shown by the prompt from `.claude/hooks/supabase-sql-gate.ts`. MCP DDL is only for an owner-approved emergency, mirrored by a migration in the same PR.
4. **Locking (`Postgres` vs `Upstash Redis`)**:
   - Cron mutual exclusion (`withCronLock` in `lib/cron/with-cron-lock.ts`) is backed by Postgres (`SystemJobExecution` lease). Do not add Redis locks for cron jobs.
   - Upstash Redis (`lib/redis.ts`, `lib/rate-limit.ts`, `utils/appointmentlock.ts`) is used only for request rate limiting, maintenance-mode / `ops:active_cron_platform` edge state, and short-lived interactive checkout/payout mutexes.
5. **Dual-Boot Multi-Host Portability (`Platform X <-> Hot-Standby Netlify`)**:
   - Keep `netlify.toml` and `netlify/functions/cron-tick.mts` intact alongside any container (`Dockerfile`) or platform (`vercel.json`) config so every `prod`/`dev` SHA builds cleanly on both active compute and hot-standby Netlify (`< 90s` failback; see `docs/deployment/README.md`).
   - Resolve the client IP once in edge middleware by runtime (the rightmost `x-forwarded-for` hop on Netlify's edge and generic proxies, `x-vercel-forwarded-for` **only** when `process.env.VERCEL === "1"`, `fly-client-ip` **only** on Fly) and stamp it as `x-familiarise-client-ip`; route handlers, Better Auth and the sign-in throttle trust **only** that middleware-stamped header (`lib/request-ip.ts`), so every path that reads the IP must stay inside the middleware matcher. Netlify sets `NETLIFY` on the build machine only, so `next.config.mjs` inlines it and runtime code must read it as a literal `process.env.NETLIFY`. Include standard `Vary: Cookie` alongside `Netlify-Vary` on public cookie-aware routes; exclude `sharp`/`@img` in `next.config.mjs` **only** on `NETLIFY === "true" || VERCEL === "1"`; and use direct Supabase Storage presigned URLs (`createSignedUploadUrl`) for any binary upload or download `> 4 MB`.

## 3. Cloudtop Worktree & Dependency Hygiene

1. **Single Canonical `node_modules`**:
   - In secondary git worktrees, always symlink the main checkout's `node_modules` (`ln -s <main-checkout>/node_modules node_modules`) and remove the worktree cleanly when finished. Never run standalone `npm ci` copies across worktrees. A worktree shares `node_modules`, so `npx prisma generate` in a worktree rewrites the main checkout's generated client; regenerate from the main checkout when finished (see `.claude/skills/booking/references/verification.md` §3).
2. **Minimum Patched Versions**:
   - Never downgrade `next` (`>= 15.5.27`) or `sharp` (`>= 0.35.5`).
3. **Verification Commands**:
   - Typecheck: `npx tsc --noEmit`
   - Lint: `npm run lint` (errors fail CI; warnings are advisory)
   - Format check: `npm run format:check`
   - Targeted Jest test: `npx jest path/to/test.ts`
   - The owner runs `next dev`, `next build`, the seed and every `prisma migrate deploy`/`resolve` against the shared database (CI's `db-migrate.yml` does the deploy on merge). `.claude/settings.json` deny rules block their usual command forms for Claude Code in every permission mode (the rules match command text, so they are a guard, not a boundary); `npm run db:generate` stays usable, and migrate commands that name a `localhost` `DIRECT_URL` are for local rehearsal.

## 4. Engineering, Documentation & Review Practices

1. **Strict TypeScript & Zod Boundary Validation**:
   - Inline escapes (`eslint-disable*`, `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck`) are rejected by `eslint.config.mjs` (`noInlineConfig`, `ban-ts-comment`): fix the underlying type. If a lint rule is wrong for a path, disable it for that path in `eslint.config.mjs` with a one-line reason.
   - Parse untrusted payloads, webhook bodies, and raw string enums through Zod schemas (`schemas/**` or `z.enum(...)`) and derive types with `z.infer<typeof schema>`. Do not use unsafe `as` casts or runtime `typeof fn === "function"` duck-typing on typed module imports.
2. **React & Sentry Discipline**:
   - List every effect dependency; never suppress `react-hooks/exhaustive-deps`. Never write `ref.current` during render — React is 18.3 (no `useEffectEvent`), so sync latest-value refs in an effect declared before the one that reads them.
   - Never capture to Sentry per row inside a loop or sweep; collect failures and report once per run. All errors share the free plan's 5,000/month quota.
3. **Documentation Split**: keep 80–85% of every doc on the current architecture and 10–15% in a closing `## Deprecated & Superseded Approaches`. Details: `docs/AGENTS.md`.
4. **Contiguous Numbering Discipline**:
   - Whenever a numbered file, folder, subfolder, seed phase, or index table entry (`x, x+1, x+2`) is deleted or inserted, immediately renumber all subsequent items (`x+2` -> `x+1`, etc.) and update all imports and cross-references in the same commit so numbering remains strictly contiguous with zero gaps or duplicates.
5. **CodeRabbit CLI & PR Comment Triage**:
   - Use the `coderabbit` CLI (`coderabbit review`; plain text is the default) for local review checks and follow `.claude/skills/workflow/references/pr-comment-triage.md` to classify and resolve every PR review comment before merging.
6. **Email Delivery Guard**:
   - Every send goes through `deliver()`, or for the newsletter broadcast batch through `heldRecipientDomain()`, so the pre-launch guard (`EMAIL_DELIVERY_MODE`) sees every recipient; see `docs/email/README.md`.
