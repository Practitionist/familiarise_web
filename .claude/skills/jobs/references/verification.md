# Verification for job changes

Every infrastructure, maintenance or observability PR updates its applicable
domain docs and skill in the same change. Document triggers, ownership/leases,
failure and recovery behavior, operational prerequisites, verification and
rollback where developers will find them. Keep the current index and links
accurate; GitHub comments supplement the runbook rather than replacing it.

Worktrees share the generated Prisma client through canonical `node_modules`.
Before typechecking a branch with different models, regenerate from that branch’s
schema and coordinate with other compilers. Generation does not apply DDL; a
missing generated model and a missing live table are different failures.

The Jest configuration keeps an explicit `@/` source mapping while retaining Next.js’s default mocks and transforms. Run targeted suites through the repository config. A CLI `--moduleNameMapper` replaces the entire map and can discard `server-only`, asset and Redis-edge mocks; do not use it as a shortcut for alias resolution.

Pure server-job suites use `@jest-environment node`, matching their deployed runtime. Transitive Next.js request imports require Node's web globals; do not hide an import failure by adding browser polyfills to backend tests.

When merging a worker migration, port its roster, limit, timeout and ledger-yield changes into the shared catalog; do not restore the adapter’s former inline schedule. Check generated output against the same inputs before and after generator refactors. Keep blank workflow names within their own source block and preserve escaped Markdown pipes. See `cron-ticker.md` for the current document-purge schedule and mocked verification boundary.

Stream background adapters currently target Netlify function URLs. Automatic
execution requires Netlify as active cron host; a host switch needs an equivalent
execution target. Keep lifecycle worker imports free of request authentication
and check actual native packaging, including CLI guards, before scheduling.

Mocks of `maintenance-cron` must provide both exported error constructors: cleanup error mapping uses `instanceof` to distinguish unreadable state from planned holds.

Tests that mock `with-cron-lock` for recording retention must also provide `readJobCheckpoint` (usually resolving `null`); the retention core reads its saved cursor before scanning.

Capture assertions that mock `@sentry/nextjs` must alias `@sentry/core` to the same mock, so native-worker helpers and Next.js routes share the asserted capture functions. Partial mocks spread the actual Core module, avoiding a circular import through the actual Next.js SDK.
