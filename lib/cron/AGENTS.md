# Cron & Background Jobs

Applies to `lib/cron/`; the root `AGENTS.md` points `app/api/cleanup/`, `app/api/admin/system-jobs/` and `netlify/functions/` here too. The root `AGENTS.md` still applies.

1. **One implementation per job (no 3-layer wrappers)**:
   - Never create parallel `scripts/<domain>/<job>.ts` + `jobs/<domain>/<job>.ts` + `app/api/cleanup/<job>/route.ts` files.
   - A background job has **one** implementation function registered in `lib/cron/cleanup-registry.ts` (dispatched via `/api/cleanup/[job]` and `/api/admin/system-jobs/run`). Do not add new `GITHUB_OUTPUT` wrapper scripts under `jobs/**` or `scripts/**`.
2. **One scheduler, one fleet switch (`ops:active_cron_platform`)**:
   - Latency-sensitive recovery sweeps run on the 5/15-min ticker (`netlify/functions/cron-tick.mts` or active platform scheduler -> `/api/cleanup/[job]?limit=N`), gated dynamically via Upstash REST key `ops:active_cron_platform` (`"netlify"` vs active Mumbai host), read once per tick and failing open when absent or unreachable. The switch stops standby Netlify double-firing only while the key is readable; a fail-open tick can run alongside the active host, so every job stays idempotent behind `withCronLock` and CAS-in-WHERE writes.
   - Money reconcilers (disputes, ledgers, payout status, stuck payouts), money batch jobs (payout batching and processing, invoice and contract lifecycle, dunning) and the statutory exports (GST register, TDS return draft) also run on the ticker in bounded, windowed slices. The housekeeping, compliance and retention jobs run on the ticker too, so no GitHub Actions workflow schedules a registry job.
3. **Playbook**: `.claude/skills/jobs/SKILL.md`.
