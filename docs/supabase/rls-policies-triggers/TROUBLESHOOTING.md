# Troubleshooting Guide: Supabase RLS & Triggers

Common issues and their solutions.

---

## Table of Contents

1. [OAuth Sign-In Failures](#oauth-sign-in-failures)
2. [RLS Policy Issues](#rls-policy-issues)
3. [Trigger Failures](#trigger-failures)
4. [Performance Problems](#performance-problems)
5. [Connection Issues](#connection-issues)
6. [Data Access Problems](#data-access-problems)

---

## OAuth Sign-In Failures

### Issue: "The table 'audit_logs' does not exist"

**Symptoms:**
- OAuth sign-in fails with database error
- Error occurs during user update operation
- NextAuth callback fails

**Cause:**
Audit triggers reference non-existent `audit_logs` table.

**Solution:**

1. **Check for audit triggers:**
```sql
SELECT tgname, tgfoid::regproc
FROM pg_trigger
WHERE tgrelid = 'users'::regclass
  AND tgisinternal = false;
```

2. **Remove audit triggers if not needed:**
```sql
DROP TRIGGER IF EXISTS audit_users_trigger ON users;
DROP FUNCTION IF EXISTS audit_users_changes();
```

3. **OR create audit_logs table if needed:**
See [How to Implement Audit Logging](./README.md#how-to-implement-audit-logging)

**Prevention:**
- Don't enable Supabase audit features without creating the required tables
- Test trigger functions before creating triggers
- Document all triggers in this repository

### Issue: "User already exists" on OAuth Sign-In

**Symptoms:**
- Can't sign in with Google/GitHub after signing up with email
- Error about duplicate email

**Cause:**
Account linking not working properly in NextAuth config.

**Solution:**

Check `app/api/auth/[...nextauth]/options.ts`:

```typescript
async signIn({ user, account, profile }) {
  if (account && account.provider !== "credentials" && user.email) {
    const existingUser = await prisma.user.findUnique({
      where: { email: user.email },
      include: { accounts: true },
    });

    if (existingUser) {
      // Link account logic...
      user.id = existingUser.id;
      return true;
    }
  }
  return !!user;
}
```

---

## RLS Policy Issues

### Issue: "new row violates row-level security policy"

**Symptoms:**
- INSERT/UPDATE operations fail
- Error mentions RLS policy violation
- Works with service role key but not as user

**Diagnosis:**

1. **Check which policy is failing:**
```sql
-- As user
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims.sub = 'failing-user-id';

-- Try the operation
INSERT INTO table_name (columns) VALUES (values);
-- Note the error message

RESET ROLE;
```

2. **List policies on the table:**
```sql
SELECT policyname, cmd, qual
FROM pg_policies
WHERE tablename = 'table_name';
```

**Common Causes:**

#### Cause 1: Missing WITH CHECK clause
```sql
-- Wrong: No WITH CHECK for INSERT
CREATE POLICY insert_policy ON users
  FOR INSERT
  TO authenticated
  USING (id = auth.uid()); -- USING is for SELECT/UPDATE/DELETE

-- Right: Use WITH CHECK for INSERT
CREATE POLICY insert_policy ON users
  FOR INSERT
  TO authenticated
  WITH CHECK (id = auth.uid());
```

#### Cause 2: Policy condition too restrictive
```sql
-- Too restrictive: Can only insert own user record
CREATE POLICY insert_policy ON consultations
  FOR INSERT
  TO authenticated
  WITH CHECK (user_id = auth.uid());

-- Better: Allow creating consultations for yourself
CREATE POLICY insert_policy ON consultations
  FOR INSERT
  TO authenticated
  WITH CHECK (consultee_id = auth.uid() OR consultant_id = auth.uid());
```

#### Cause 3: No INSERT policy exists
```sql
-- Check if INSERT policy exists
SELECT policyname, cmd
FROM pg_policies
WHERE tablename = 'table_name'
  AND cmd = 'INSERT';

-- Add one if missing
CREATE POLICY authenticated_insert ON table_name
  FOR INSERT
  TO authenticated
  WITH CHECK (true); -- Adjust condition as needed
```

**Solution Template:**
```sql
-- Drop and recreate policy with correct conditions
DROP POLICY IF EXISTS policy_name ON table_name;

CREATE POLICY policy_name ON table_name
  FOR INSERT -- or UPDATE, DELETE, SELECT
  TO authenticated
  WITH CHECK (
    -- Your condition here
    user_id = auth.uid()
  );
```

### Issue: "permission denied for table X"

**Symptoms:**
- Cannot read/write table
- Error even though RLS is enabled
- Works in Supabase dashboard but not in app

**Cause:**
RLS enabled but no policies exist.

**Solution:**

1. **Check if RLS is enabled:**
```sql
SELECT tablename, rowsecurity
FROM pg_tables
WHERE tablename = 'table_name';
```

2. **Check for policies:**
```sql
SELECT policyname
FROM pg_policies
WHERE tablename = 'table_name';
```

3. **Add appropriate policies:**
```sql
-- Example: Allow users to read all records
CREATE POLICY public_read ON table_name
  FOR SELECT
  TO authenticated
  USING (true);
```

### Issue: Can See Other Users' Data

**Symptoms:**
- User can see data they shouldn't
- Privacy leak
- All records visible regardless of owner

**Cause:**
Policy condition is too permissive.

**Solution:**

1. **Check current policy:**
```sql
SELECT policyname, qual
FROM pg_policies
WHERE tablename = 'table_name'
  AND cmd = 'SELECT';
```

2. **Look for overly permissive policies:**
```sql
-- BAD: Allows seeing all records
USING (true)

-- GOOD: Restrict to owner
USING (user_id = auth.uid())

-- ALSO GOOD: Allow public browse but private edit
-- SELECT: USING (true)
-- UPDATE: USING (user_id = auth.uid())
```

3. **Update policy:**
```sql
DROP POLICY IF EXISTS policy_name ON table_name;

CREATE POLICY policy_name ON table_name
  FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());
```

---

## Trigger Failures

### Issue: Trigger References Non-Existent Table/Column

**Symptoms:**
- INSERT/UPDATE fails with "table/column does not exist"
- Error mentions trigger name
- Operation works when trigger is disabled

**Diagnosis:**
```sql
-- Find the trigger
SELECT tgname, tgfoid::regproc
FROM pg_trigger
WHERE tgrelid = 'table_name'::regclass;

-- View trigger function source
SELECT pg_get_functiondef(oid)
FROM pg_proc
WHERE proname = 'function_name';
```

**Solution:**

Option 1: Fix the function
```sql
-- Drop and recreate function with correct table/column names
DROP FUNCTION IF EXISTS function_name() CASCADE;

CREATE OR REPLACE FUNCTION function_name()
RETURNS TRIGGER AS $$
BEGIN
  -- Fixed function code here
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Recreate trigger
CREATE TRIGGER trigger_name
  BEFORE UPDATE ON table_name
  FOR EACH ROW
  EXECUTE FUNCTION function_name();
```

Option 2: Remove trigger if not needed
```sql
DROP TRIGGER IF EXISTS trigger_name ON table_name;
DROP FUNCTION IF EXISTS function_name();
```

### Issue: "infinite recursion detected in trigger"

**Symptoms:**
- Operation hangs then fails
- Error about recursion limit
- Trigger modifies the same table

**Cause:**
Trigger updates the table it's attached to without protection.

**Bad Example:**
```sql
CREATE OR REPLACE FUNCTION update_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE users SET updated_at = NOW() WHERE id = NEW.id;
  -- This causes recursion!
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
```

**Solution:**

Option 1: Modify NEW directly
```sql
CREATE OR REPLACE FUNCTION update_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  -- Modify NEW instead of UPDATE query
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
```

Option 2: Use WHEN clause
```sql
CREATE TRIGGER update_timestamp_trigger
  BEFORE UPDATE ON users
  FOR EACH ROW
  WHEN (NEW.updated_at IS DISTINCT FROM OLD.updated_at)
  -- Only fire if updated_at changed
  EXECUTE FUNCTION update_timestamp();
```

### Issue: Trigger Slows Down Operations

**Symptoms:**
- INSERT/UPDATE takes much longer than expected
- Trigger performs complex operations
- Multiple triggers on same table

**Solution:**

1. **Identify slow triggers:**
```sql
-- Enable timing
\timing on

-- Test operation
INSERT INTO table_name (columns) VALUES (values);
-- Note the time

-- Disable trigger
ALTER TABLE table_name DISABLE TRIGGER trigger_name;

-- Test again
INSERT INTO table_name (columns) VALUES (values);
-- Compare times

-- Re-enable
ALTER TABLE table_name ENABLE TRIGGER trigger_name;
```

2. **Optimize trigger function:**
- Avoid complex queries in triggers
- Use EXISTS instead of COUNT
- Minimize database calls
- Consider moving logic to application code

3. **Use AFTER triggers instead of BEFORE when possible:**
```sql
-- BEFORE trigger (runs during transaction)
CREATE TRIGGER before_trigger
  BEFORE INSERT ON table_name
  FOR EACH ROW
  EXECUTE FUNCTION function_name();

-- AFTER trigger (can be deferred)
CREATE TRIGGER after_trigger
  AFTER INSERT ON table_name
  FOR EACH ROW
  EXECUTE FUNCTION function_name();
```

---

## Performance Problems

### Issue: Slow Queries with RLS

**Symptoms:**
- Queries take seconds instead of milliseconds
- Query works fast as service_role
- EXPLAIN shows policy evaluation

**Diagnosis:**
```sql
EXPLAIN ANALYZE
SELECT * FROM users WHERE email = 'user@example.com';
```

Look for:
- Sequential scans instead of index scans
- Policy conditions evaluated for every row
- Multiple EXISTS subqueries

**Solutions:**

#### Solution 1: Add indexes for policy conditions
```sql
-- If policy uses: userId = auth.uid()
CREATE INDEX idx_table_user_id ON table_name("userId");

-- If policy has EXISTS subquery
CREATE INDEX idx_users_id ON users(id);
CREATE INDEX idx_users_role ON users(role);
```

#### Solution 2: Simplify policy conditions
```sql
-- Complex (slower)
CREATE POLICY complex_policy ON table_name
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM users u
      JOIN consultants c ON u.id = c.user_id
      WHERE c.id = table_name.consultant_id
        AND u.role = 'CONSULTANT'
        AND u.active = true
    )
  );

-- Simpler (faster)
CREATE POLICY simple_policy ON table_name
  FOR SELECT
  TO authenticated
  USING (
    consultant_id = auth.uid()
  );
```

#### Solution 3: Use materialized views
For complex queries with RLS, create materialized views:
```sql
CREATE MATERIALIZED VIEW consultant_stats AS
SELECT
  consultant_id,
  COUNT(*) as total_consultations,
  AVG(rating) as avg_rating
FROM consultations
GROUP BY consultant_id;

-- Refresh periodically
REFRESH MATERIALIZED VIEW consultant_stats;
```

### Issue: Connection Pool Exhaustion

**Symptoms:**
- "Too many connections" error
- App becomes unresponsive
- Works fine after restart

**Cause:**
- Using direct connection in serverless environment
- Not closing Prisma clients
- Too many concurrent requests

**Solution:**

1. **Use connection pooling:**
```env
# Use pooler URL
DATABASE_URL="postgresql://...pooler.supabase.com:6543/postgres?pgbouncer=true"

# Direct connection only for migrations
DIRECT_URL="postgresql://...pooler.supabase.com:5432/postgres"
```

2. **Optimize Prisma client:**
```typescript
// lib/prisma.ts
import { PrismaClient } from '@prisma/client'

const prismaClientSingleton = () => {
  return new PrismaClient({
    log: ['error'],
    // Don't log queries in production
  })
}

declare global {
  var prisma: undefined | ReturnType<typeof prismaClientSingleton>
}

const prisma = globalThis.prisma ?? prismaClientSingleton()

export default prisma

if (process.env.NODE_ENV !== 'production') globalThis.prisma = prisma
```

3. **Increase Supabase connection limit:**
- Go to Supabase Dashboard → Settings → Database
- Increase max_connections (requires plan upgrade for high limits)

---

## Connection Issues

### Issue: "Connection refused" or "Connection timeout"

**Symptoms:**
- Can't connect to database
- Works in Supabase dashboard
- Timeout after 30 seconds

**Solutions:**

1. **Check connection string:**
```bash
# Test connection
psql "postgresql://user:password@host:port/database"
```

2. **Verify environment variables:**
```bash
# In your app directory
cat .env.local | grep DATABASE_URL
```

3. **Check IP allowlist:**
- Go to Supabase Dashboard → Settings → Database
- Ensure your IP is not blocked
- Consider using IPv4 vs IPv6

4. **Use correct port:**
- Pooler: 6543
- Direct: 5432

### Issue: SSL/TLS Errors

**Symptoms:**
- "SSL connection required"
- "Certificate verification failed"

**Solution:**
```typescript
// In Prisma schema
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
  directUrl = env("DIRECT_URL")
  // Add SSL mode if needed
}
```

Or in connection string:
```
postgresql://...?sslmode=require
```

---

## Data Access Problems

### Issue: NextAuth Can't Read User Data

**Symptoms:**
- Session is empty
- User data not available in callbacks
- Works in SQL editor

**Cause:**
RLS preventing NextAuth adapter from reading user data.

**Solution:**

Use service role key for NextAuth operations:

```typescript
// lib/prisma.ts - Create separate client for NextAuth
import { PrismaClient } from '@prisma/client'

// Regular client (with RLS)
export const prisma = new PrismaClient()

// Admin client for NextAuth (bypasses RLS)
export const prismaAuth = new PrismaClient({
  datasources: {
    db: {
      url: process.env.DATABASE_URL_ADMIN, // Service role connection
    },
  },
})
```

```typescript
// app/api/auth/[...nextauth]/options.ts
import { prismaAuth } from '@/lib/prisma'

const authOptions: NextAuthOptions = {
  adapter: PrismaAdapter(prismaAuth), // Use admin client
  // ...
}
```

### Issue: Flutter App Can't Access Data After Removing Triggers

**Symptoms:**
- Flutter app errors after trigger removal
- "Column 'audit_logs' not found" error (from Flutter)

**Solution:**

Triggers were not used by Flutter app. If you see errors:

1. **Check Flutter Supabase client version:**
```yaml
# pubspec.yaml
dependencies:
  supabase_flutter: ^latest
```

2. **Verify Flutter is using correct schema:**
```dart
// Regenerate types
supabase gen types typescript --local
```

3. **Clear Flutter cache:**
```bash
flutter clean
flutter pub get
```

---

## Prevention Checklist

Before making database changes:

- [ ] Test changes in development/staging first
- [ ] Backup current policies/triggers
- [ ] Document changes in this repository
- [ ] Test with different user roles
- [ ] Monitor performance after deployment
- [ ] Have rollback plan ready

---

## Emergency Contacts & Resources

- **Supabase Status**: https://status.supabase.com
- **PostgreSQL Docs**: https://www.postgresql.org/docs/
- **This Project Docs**: [README.md](./README.md)

---

## Getting Help

1. Check this troubleshooting guide
2. Review [Quick Reference](./QUICK_REFERENCE.md)
3. Check Supabase Dashboard logs
4. Review recent database changes
5. Test queries in SQL Editor
6. Create database backup before attempting fixes
