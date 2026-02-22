# Prisma Migration Safety Guide

How to run Prisma schema migrations safely on this app, especially during active use.

---

## `migrate dev` vs `migrate deploy`

| Command | When to use |
|---------|------------|
| `prisma migrate dev` | **Local dev only.** Generates migration files, resets dev DB, regenerates client. Never run in production — it may reset data. |
| `prisma migrate deploy` | **Production / CI.** Applies pending migrations in order without prompting. Safe for automated pipelines. |
| `prisma migrate resolve --applied <name>` | Fix drift: marks a migration as applied without running it (use when you manually applied a change). |
| `prisma migrate status` | Check which migrations are pending or failed. Run this before and after deploying. |

---

## Common Migration Failures

### 1. Schema Drift — "Drift detected"

**Cause**: Someone ran `prisma db push` directly in production, or made a manual `ALTER TABLE` in the DB. The migration history no longer matches the actual schema.

**Fix**:
```bash
# Option A: Mark the drift as intentional (preserves data)
npx prisma migrate resolve --applied <migration-name>

# Option B: Regenerate the baseline (destructive — dev only)
npx prisma migrate reset
```

**Prevention**: Never use `prisma db push` or manual DDL in production. Always create a migration file.

---

### 2. Cron Job Holds DB Lock — Timeout Waiting for Lock

**Cause**: A cron job (e.g. `reconcile-payment-status`) is in the middle of a long transaction when the migration tries to `ALTER TABLE`. Postgres waits for the lock — migration hangs.

**Fix**: Activate **OFFLINE** maintenance mode before migrating. All 27 cron jobs check `abortIfMaintenance()` at startup and skip cleanly.

```bash
# 1. Activate OFFLINE maintenance
# (Admin panel → Maintenance → Phase: OFFLINE)

# 2. Wait ~2 minutes for any in-flight cron jobs to finish

# 3. Run migration
npx prisma migrate deploy

# 4. End maintenance
```

---

### 3. NOT NULL Column, No Default, Existing Rows — Migration Fails Mid-Apply

**Cause**: Adding a `NOT NULL` column without `@default()` when rows already exist. Postgres rejects the migration because existing rows would violate the constraint.

**Fix options**:
```prisma
// Option A: Add a default (preferred)
newColumn   String   @default("value")

// Option B: Make nullable first, backfill data, then add NOT NULL in a second migration
newColumn   String?
```

**Safe sequence for adding NOT NULL**:
1. Migration 1: Add column as nullable (`String?`)
2. Data migration: backfill all rows (`UPDATE table SET new_column = 'default' WHERE new_column IS NULL`)
3. Migration 2: Add NOT NULL constraint (`String`)

---

### 4. "Already Applied" Error — Dev vs Prod History Mismatch

**Cause**: Migration was created on a feature branch and applied to prod manually, but the migration history in the `_prisma_migrations` table is out of sync.

**Fix**:
```bash
npx prisma migrate status         # See what's pending/applied
npx prisma migrate resolve --applied <migration-name>
```

**Prevention**: Always use `migrate deploy` in CI/CD. Never apply migrations manually.

---

### 5. Directus Connection Pool — Lock Contention

**Cause**: Directus (our separate CMS service on the same Supabase PostgreSQL) holds open connections that compete with migration locks.

**Impact**: Usually harmless — Directus reads only. But during long `ALTER TABLE` operations, Directus queries may timeout.

**Fix**: Usually no action needed — retry. For long migrations:
1. Pause Directus service in Railway/Docker before migrating
2. Run migration
3. Restart Directus

---

## Safe Migration Sequence (Recommended)

```
1. Activate OFFLINE maintenance mode
2. Wait 2 minutes (in-flight cron jobs finish)
3. Verify: npx prisma migrate status
4. Deploy: npx prisma migrate deploy
5. Verify: npx prisma migrate status (no pending migrations)
6. Smoke test the app (check /api/health, key pages)
7. End OFFLINE maintenance mode
```

For migrations that take > 30 seconds (large tables), use `DEGRADED` mode instead of `OFFLINE` so the site remains readable.

---

## ConvertKit Schema Migration (Issue #334)

When implementing Issue #334, the Newsletter model may need additional fields. The current model is:

```prisma
model Newsletter {
  id        String   @id @default(uuid())
  email     String   @unique
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}
```

**Checklist before migrating**:
- [ ] Add `@default()` to any new NOT NULL fields
- [ ] Test migration on a local copy of production data first (`prisma migrate dev --preview-feature`)
- [ ] Schedule during low-traffic window (late night IST)
- [ ] Activate OFFLINE maintenance before running `migrate deploy`
- [ ] Add the 4 new ConvertKit cron jobs to `lib/maintenance-cron.ts` FINANCIAL_JOB_NAMES if they touch payments

---

## Directus CMS (Issue #312)

Directus uses its own `directus_*` and `cms_*` prefixed tables in the same Supabase PostgreSQL. These are created and managed by Directus itself — no Prisma conflict.

**Key facts**:
- Prisma migrations never touch `directus_*` or `cms_*` tables
- Directus migrations never touch Prisma tables
- During a long Prisma migration, Directus may see connection timeouts — acceptable
- If you need to pause Directus: scale to 0 in Railway → run migration → scale back up
