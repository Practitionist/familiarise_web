# Quick Reference: Supabase RLS & Triggers

Quick commands and snippets for common database operations.

---

## Check Database Status

### List All RLS Policies
```sql
SELECT tablename, policyname, roles, cmd
FROM pg_policies
WHERE schemaname = 'public'
ORDER BY tablename;
```

### Check Which Tables Have RLS Enabled
```sql
SELECT tablename, rowsecurity
FROM pg_tables
WHERE schemaname = 'public'
ORDER BY tablename;
```

### List All Triggers
```sql
SELECT
  c.relname as table_name,
  t.tgname as trigger_name,
  p.proname as function_name
FROM pg_trigger t
JOIN pg_class c ON t.tgrelid = c.oid
JOIN pg_proc p ON t.tgfoid = p.oid
WHERE t.tgisinternal = false
  AND c.relnamespace = 'public'::regnamespace
ORDER BY c.relname;
```

### View Function Source Code
```sql
SELECT pg_get_functiondef(oid)
FROM pg_proc
WHERE proname = 'function_name_here';
```

---

## Common RLS Policy Patterns

### User Can Only See Their Own Data
```sql
CREATE POLICY user_select_policy ON table_name
  FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY user_update_policy ON table_name
  FOR UPDATE
  TO authenticated
  USING (user_id = auth.uid());
```

### Public Read, Authenticated Write
```sql
CREATE POLICY public_read ON table_name
  FOR SELECT
  TO anon, authenticated
  USING (true);

CREATE POLICY authenticated_write ON table_name
  FOR INSERT
  TO authenticated
  WITH CHECK (true);
```

### Admin Only Access
```sql
CREATE POLICY admin_only ON table_name
  FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM users
      WHERE users.id = auth.uid()
      AND users.role = 'ADMIN'
    )
  );
```

### Owner or Admin Can Modify
```sql
CREATE POLICY owner_or_admin_update ON table_name
  FOR UPDATE
  TO authenticated
  USING (
    user_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM users
      WHERE users.id = auth.uid()
      AND users.role IN ('ADMIN', 'STAFF')
    )
  );
```

---

## Common Trigger Patterns

### Auto-Update `updatedAt` Column
```sql
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW."updatedAt" = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_table_updated_at
  BEFORE UPDATE ON table_name
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();
```

### Auto-Generate Slug from Title
```sql
CREATE OR REPLACE FUNCTION generate_slug()
RETURNS TRIGGER AS $$
BEGIN
  NEW.slug = lower(regexp_replace(NEW.title, '[^a-zA-Z0-9]+', '-', 'g'));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER generate_slug_trigger
  BEFORE INSERT OR UPDATE ON table_name
  FOR EACH ROW
  WHEN (NEW.title IS NOT NULL)
  EXECUTE FUNCTION generate_slug();
```

### Prevent Deletion (Soft Delete Instead)
```sql
CREATE OR REPLACE FUNCTION soft_delete()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    UPDATE table_name
    SET deleted_at = NOW()
    WHERE id = OLD.id;
    RETURN NULL; -- Prevent actual deletion
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER soft_delete_trigger
  BEFORE DELETE ON table_name
  FOR EACH ROW
  EXECUTE FUNCTION soft_delete();
```

---

## Testing RLS Policies

### Test as Specific User
```sql
-- Start transaction
BEGIN;

-- Set role and user ID
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims.sub = 'user-uuid-here';

-- Run your test queries
SELECT * FROM users;
SELECT * FROM "ConsultantProfile";

-- Rollback to reset
ROLLBACK;
```

### Test as Anonymous User
```sql
BEGIN;
SET LOCAL ROLE anon;
SELECT * FROM "ConsultantProfile"; -- Should work for public data
ROLLBACK;
```

### Test with Different Roles
```sql
BEGIN;
SET LOCAL ROLE service_role;
SELECT * FROM users; -- Should bypass RLS
ROLLBACK;
```

---

## Emergency Commands

### Temporarily Disable RLS (Development Only)
```sql
-- DANGER: Only use in development!
ALTER TABLE table_name DISABLE ROW LEVEL SECURITY;
```

### Re-enable RLS
```sql
ALTER TABLE table_name ENABLE ROW LEVEL SECURITY;
```

### Drop All Policies on a Table
```sql
-- List policies first
SELECT policyname FROM pg_policies WHERE tablename = 'table_name';

-- Drop each policy
DROP POLICY IF EXISTS policy_name ON table_name;
```

### Drop a Trigger
```sql
DROP TRIGGER IF EXISTS trigger_name ON table_name;
```

### Drop a Function (and all dependent triggers)
```sql
DROP FUNCTION IF EXISTS function_name() CASCADE;
```

---

## Performance Tips

### Check Query Execution Plan with RLS
```sql
EXPLAIN ANALYZE
SELECT * FROM users WHERE id = 'user-uuid';
```

### Find Slow Policies
```sql
-- Enable timing
\timing on

-- Run queries and compare execution times
SELECT * FROM table_name WHERE condition;
```

### Index Recommendations for RLS
- Always index columns used in RLS policy conditions
- Index foreign keys used in policy EXISTS checks
- Index `auth.uid()` comparisons (usually on `user_id` or `userId`)

```sql
-- Example
CREATE INDEX idx_users_id ON users(id);
CREATE INDEX idx_consultant_profile_user_id ON "ConsultantProfile"("userId");
```

---

## Connection Strings

### Pooler (Recommended for Serverless)
```
postgresql://postgres.[PROJECT]:password@aws-region.pooler.supabase.com:6543/postgres?pgbouncer=true
```

### Direct Connection
```
postgresql://postgres.[PROJECT]:password@aws-region.pooler.supabase.com:5432/postgres
```

### Using psql
```bash
psql "postgresql://postgres.PROJECT:PASSWORD@HOST:5432/postgres"
```

---

## Useful Environment Variables

```env
# .env.local
DATABASE_URL="..." # Pooler connection (for Prisma migrations with pgbouncer=true)
DIRECT_URL="..."   # Direct connection (for migrations)

NEXT_PUBLIC_SUPABASE_URL="https://PROJECT.supabase.co"
NEXT_PUBLIC_SUPABASE_ANON_KEY="..."
SUPABASE_SERVICE_ROLE_KEY="..." # Server-side only, bypasses RLS
```

---

## Common Error Messages

### "The table 'X' does not exist"
- Trigger references non-existent table
- Check trigger function source: `SELECT pg_get_functiondef(oid) FROM pg_proc WHERE proname = 'function_name';`

### "new row violates row-level security policy"
- RLS policy is too restrictive
- Check policy conditions: `SELECT * FROM pg_policies WHERE tablename = 'table_name';`
- Test with `SET LOCAL ROLE authenticated;`

### "permission denied for table X"
- RLS is enabled but no policies exist
- Add policies or use service role key

### "infinite recursion detected in trigger"
- Trigger modifies the same table it's attached to
- Use WHEN clause to prevent recursion
- Example: `WHEN (NEW.updated_at IS DISTINCT FROM OLD.updated_at)`

---

## Backup Commands

### Export Policies for Backup
```sql
-- Save to file
psql "connection-string" -c "\
SELECT 'CREATE POLICY ' || policyname || ' ON ' || tablename || \
       ' FOR ' || cmd || ' TO ' || array_to_string(roles, ', ') || \
       ' USING (' || qual || ');' \
FROM pg_policies WHERE schemaname = 'public';" \
> policies_backup.sql
```

### Export Triggers for Backup
```sql
psql "connection-string" -c "\
SELECT pg_get_triggerdef(oid) || ';' \
FROM pg_trigger \
WHERE tgisinternal = false \
  AND tgrelid::regclass::text LIKE 'public.%';" \
> triggers_backup.sql
```

---

## Quick Links

- [Main Documentation](./README.md)
- [Troubleshooting Guide](./TROUBLESHOOTING.md)
- [Supabase Dashboard](https://supabase.com/dashboard)
