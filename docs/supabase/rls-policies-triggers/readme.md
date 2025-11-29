# Supabase Database: RLS Policies & Triggers Documentation

**Last Updated:** October 10, 2025
**Database:** Supabase PostgreSQL (aws-0-ap-south-1)

---

## Table of Contents

1. [Overview](#overview)
2. [Incident Report: Audit Logs Issue](#incident-report-audit-logs-issue)
3. [Row Level Security (RLS) Policies](#row-level-security-rls-policies)
4. [Active Triggers](#active-triggers)
5. [How to Implement Audit Logging](#how-to-implement-audit-logging)
6. [Best Practices](#best-practices)
7. [Maintenance](#maintenance)

---

## Overview

This document provides comprehensive information about the database security policies and triggers configured in your Supabase PostgreSQL database. It serves as both a reference and a guide for maintaining and extending database functionality.

### Key Components

- **RLS Policies**: 42 tables with Row Level Security enabled
- **Active Triggers**: 31 `updated_at` auto-update triggers + 1 rating calculation trigger
- **Removed**: 6 broken audit triggers (October 10, 2025)

---

## Incident Report: Audit Logs Issue

### Problem

**Date:** October 10, 2025
**Error:** `Invalid prisma.user.update() invocation: The table 'audit_logs' does not exist in the current database`

**Root Cause:**

- Audit triggers were created on multiple tables referencing a non-existent `audit_logs` table
- These triggers were likely created accidentally via Supabase Dashboard or Flutter SDK
- OAuth sign-in flow failed when NextAuth attempted to update user records

### Affected Tables

The following tables had broken audit triggers:

1. `users` - Blocked OAuth authentication
2. `Appointment` - Would fail on updates
3. `ConsultantProfile` - Would fail on updates
4. `ConsultantReview` - Would fail on updates
5. `Consultation` - Would fail on updates
6. `ConsulteeProfile` - Would fail on updates
7. `Payment` - Would fail on updates

### Resolution

**Actions Taken:**

```sql
-- Removed all audit triggers
DROP TRIGGER IF EXISTS audit_users_trigger ON users;
DROP TRIGGER IF EXISTS audit_appointment_trigger ON "Appointment";
DROP TRIGGER IF EXISTS audit_consultantprofile_trigger ON "ConsultantProfile";
DROP TRIGGER IF EXISTS audit_consultantreview_trigger ON "ConsultantReview";
DROP TRIGGER IF EXISTS audit_consultation_trigger ON "Consultation";
DROP TRIGGER IF EXISTS audit_consulteeprofile_trigger ON "ConsulteeProfile";
DROP TRIGGER IF EXISTS audit_payment_trigger ON "Payment";

-- Removed all audit functions
DROP FUNCTION IF EXISTS audit_users_changes();
DROP FUNCTION IF EXISTS audit_appointment_changes();
DROP FUNCTION IF EXISTS audit_consultantprofile_changes();
DROP FUNCTION IF EXISTS audit_consultantreview_changes();
DROP FUNCTION IF EXISTS audit_consultation_changes();
DROP FUNCTION IF EXISTS audit_consulteeprofile_changes();
DROP FUNCTION IF EXISTS audit_payment_changes();
```

**Result:** ✅ OAuth sign-in now works correctly. No application functionality was affected as audit logging was not implemented in either the Next.js or Flutter applications.

---

## Row Level Security (RLS) Policies

### Overview

Row Level Security is enabled on 42 tables to control data access at the database level. RLS policies run before any queries and ensure users can only access data they're authorized to see.

### Tables with RLS Enabled

All application tables have RLS enabled (`rowsecurity = true`):

```
✅ users                          ✅ Domain
✅ accounts                       ✅ SubDomain
✅ sessions                       ✅ Tag
✅ ConsultantProfile              ✅ Topic
✅ ConsulteeProfile               ✅ Newsletter
✅ StaffProfile                   ✅ WebinarPlan
✅ ConsultantReview               ✅ Webinar
✅ ConsultationPlan               ✅ ClassPlan
✅ Consultation                   ✅ Class
✅ SubscriptionPlan               ✅ ClassContent
✅ Subscription                   ✅ Waitlist
✅ Appointment                    ✅ Feedback
✅ AppointmentDocument            ✅ SupportTicket
✅ SlotOfAppointment              ✅ SupportResponse
✅ SlotOfAvailabilityWeekly       ✅ cookie_preferences
✅ SlotOfAvailabilityCustom       ✅ notification_preferences
✅ MeetingSession                 ✅ verificationtokens
✅ Recording                      ✅ Payment
✅ DiscountCode
```

**Note:** Join tables (`_*`) do not have RLS enabled as they're managed internally by Prisma.

### Current RLS Policies (50+ policies)

#### 1. Users Table

```sql
-- Allow authenticated users to insert (sign up)
Policy: authenticated_users_insert
  Role: authenticated
  Command: INSERT
  Condition: (none - all authenticated users can insert)

-- Allow users to read their own profile OR public profiles
Policy: authenticated_users_select
  Role: authenticated
  Command: SELECT
  Condition: (id = auth.uid() OR auth.role() = 'service_role')

-- Allow users to update their own profile
Policy: authenticated_users_update
  Role: authenticated
  Command: UPDATE
  Condition: (id = auth.uid())

-- Allow users to delete their own account
Policy: authenticated_users_delete
  Role: authenticated
  Command: DELETE
  Condition: (id = auth.uid())

-- Allow public to read basic user profiles
Policy: public_profile_read_users
  Role: anon, authenticated
  Command: SELECT
  Condition: true (all users visible for browse/search)
```

#### 2. ConsultantProfile Table

```sql
-- Public read access (for browse/search)
Policy: public_read_consultantprofile
  Role: anon, authenticated
  Command: SELECT
  Condition: true

-- Allow authenticated users to create consultant profiles
Policy: owner_insert_consultantprofile
  Role: authenticated
  Command: INSERT
  Condition: (none)

-- Only profile owner can update
Policy: owner_update_consultantprofile
  Role: authenticated
  Command: UPDATE
  Condition: (userId = auth.uid())

-- Only profile owner can delete
Policy: owner_delete_consultantprofile
  Role: authenticated
  Command: DELETE
  Condition: (userId = auth.uid())
```

#### 3. Domain, SubDomain, Tag, Topic (Metadata Tables)

These tables follow a consistent pattern:

```sql
-- Public read for browse/filter features
Policy: public_read_*
  Role: anon, authenticated
  Command: SELECT
  Condition: true

-- Authenticated users can add/update/delete
Policy: authenticated_insert_*
  Role: authenticated
  Command: INSERT

Policy: authenticated_update_*
  Role: authenticated
  Command: UPDATE
  Condition: true

Policy: authenticated_delete_*
  Role: authenticated
  Command: DELETE
  Condition: true
```

**Applies to:** Domain, SubDomain, Tag, Topic, ConsultationPlan, WebinarPlan, ClassPlan

#### 4. Feedback & Support Tables

User-scoped policies (users can only see/modify their own records):

```sql
-- User can see only their feedback/tickets
Policy: user_select_feedback
  Role: authenticated
  Command: SELECT
  Condition: (userId = auth.uid())

-- User can create feedback/tickets
Policy: user_insert_feedback
  Role: authenticated
  Command: INSERT

-- User can update only their feedback/tickets
Policy: user_update_feedback
  Role: authenticated
  Command: UPDATE
  Condition: (userId = auth.uid())

-- User can delete only their feedback/tickets
Policy: user_delete_feedback
  Role: authenticated
  Command: DELETE
  Condition: (userId = auth.uid())
```

**Applies to:** Feedback, SupportTicket, SupportResponse

#### 5. Cookie & Notification Preferences

```sql
Policy: user_select_cookie_preferences
  Role: authenticated
  Command: SELECT
  Condition: (userId = auth.uid())
```

**Applies to:** cookie_preferences, notification_preferences

### Policy Analysis

#### Security Strengths

✅ **User Isolation**: Users can only modify their own data (profiles, feedback, preferences)
✅ **Public Browse**: Anonymous users can browse consultants (required for landing pages)
✅ **Service Role Bypass**: Backend services can access all data via service_role
✅ **Authenticated Actions**: Write operations require authentication

#### Potential Improvements

⚠️ **Consider Adding:**

1. **Admin Policies**: Add specific policies for ADMIN/STAFF roles
2. **Appointment Security**: More granular policies for appointment access (consultant vs consultee)
3. **Payment Security**: Restrict payment data access more strictly
4. **Rate Limiting**: Consider implementing rate limiting on INSERT operations

---

## Active Triggers

### 1. Auto-Update Triggers (`updated_at` columns)

These triggers automatically update the `updatedAt` timestamp whenever a row is modified.

**Function:**

```sql
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updatedAt = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
```

**Applied to 31 tables:**

```
✅ Appointment                   ✅ Subscription
✅ AppointmentDocument           ✅ SubscriptionPlan
✅ Class                         ✅ SupportResponse
✅ ClassContent                  ✅ SupportTicket
✅ ClassPlan                     ✅ Tag
✅ ConsultantProfile             ✅ Topic
✅ ConsultantReview              ✅ Webinar
✅ Consultation                  ✅ WebinarPlan
✅ ConsultationPlan              ✅ Domain
✅ ConsulteeProfile              ✅ SubDomain
✅ DiscountCode                  ✅ Feedback
✅ MeetingSession                ✅ Payment
✅ Newsletter                    ✅ Recording
✅ SlotOfAppointment             ✅ SlotOfAvailabilityCustom
✅ SlotOfAvailabilityWeekly      ✅ StaffProfile
```

**Example:**

```sql
CREATE TRIGGER update_appointment_updated_at
  BEFORE UPDATE ON "Appointment"
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();
```

### 2. Business Logic Trigger

#### Consultant Rating Auto-Update

Automatically recalculates consultant rating when reviews are added/updated/deleted.

**Trigger:**

```sql
CREATE TRIGGER update_consultant_rating_trigger
  AFTER INSERT OR UPDATE OR DELETE ON "ConsultantReview"
  FOR EACH ROW
  EXECUTE FUNCTION update_consultant_rating();
```

**Purpose:** Keeps `ConsultantProfile.rating` in sync with average of all `ConsultantReview.rating` values.

---

## How to Implement Audit Logging

If you need audit logging in the future, follow this complete implementation guide.

### Step 1: Create Audit Logs Table

Add to your Prisma schema (`prisma/schema.prisma`):

```prisma
model AuditLog {
  id          String   @id @default(uuid())
  tableName   String   @map("table_name")
  recordId    String   @map("record_id")
  operation   String   // INSERT, UPDATE, DELETE
  oldValues   Json?    @map("old_values")
  newValues   Json?    @map("new_values")
  changedBy   String?  @map("changed_by") // User ID from auth.uid()
  changedAt   DateTime @default(now()) @map("changed_at")
  ipAddress   String?  @map("ip_address")
  userAgent   String?  @map("user_agent")

  @@index([tableName])
  @@index([recordId])
  @@index([changedBy])
  @@index([changedAt])
  @@map("audit_logs")
}
```

### Step 2: Create and Run Migration

```bash
npx prisma migrate dev --name add_audit_logs
```

### Step 3: Create Audit Function (SQL)

Run in Supabase SQL Editor:

```sql
-- Generic audit function
CREATE OR REPLACE FUNCTION audit_table_changes()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  INSERT INTO audit_logs (
    table_name,
    record_id,
    operation,
    old_values,
    new_values,
    changed_by,
    changed_at
  ) VALUES (
    TG_TABLE_NAME,
    COALESCE(NEW.id, OLD.id)::text,
    TG_OP,
    CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE NULL END,
    CASE WHEN TG_OP IN ('INSERT', 'UPDATE') THEN to_jsonb(NEW) ELSE NULL END,
    auth.uid()::text,
    NOW()
  );

  RETURN COALESCE(NEW, OLD);
END;
$$;
```

### Step 4: Add Triggers to Tables

Only add triggers to sensitive tables (not all tables):

```sql
-- Example: Audit the users table
CREATE TRIGGER audit_users_trigger
  AFTER INSERT OR UPDATE OR DELETE ON users
  FOR EACH ROW
  EXECUTE FUNCTION audit_table_changes();

-- Example: Audit payments
CREATE TRIGGER audit_payment_trigger
  AFTER INSERT OR UPDATE OR DELETE ON "Payment"
  FOR EACH ROW
  EXECUTE FUNCTION audit_table_changes();

-- Repeat for other sensitive tables
```

### Step 5: Add RLS Policies for Audit Logs

```sql
-- Enable RLS
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;

-- Only admins and staff can read audit logs
CREATE POLICY admin_read_audit_logs ON audit_logs
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM users
      WHERE users.id = auth.uid()
      AND users.role IN ('ADMIN', 'STAFF')
    )
  );

-- System can insert (triggers run as postgres)
CREATE POLICY system_insert_audit_logs ON audit_logs
  FOR INSERT
  WITH CHECK (true);
```

### Step 6: Query Audit Logs

```typescript
// In your Next.js API route
import prisma from "@/lib/prisma";

// Get audit history for a specific record
export async function getAuditHistory(tableName: string, recordId: string) {
  return await prisma.auditLog.findMany({
    where: {
      tableName,
      recordId,
    },
    orderBy: {
      changedAt: "desc",
    },
  });
}

// Get recent changes by user
export async function getUserActivity(userId: string, limit = 50) {
  return await prisma.auditLog.findMany({
    where: {
      changedBy: userId,
    },
    orderBy: {
      changedAt: "desc",
    },
    take: limit,
  });
}
```

### Step 7: Admin Dashboard Integration

Create an admin page to view audit logs:

```typescript
// app/admin/audit-logs/page.tsx
import { getServerSession } from 'next-auth';
import prisma from '@/lib/prisma';

export default async function AuditLogsPage() {
  const session = await getServerSession();

  // Check if user is admin
  if (session?.user?.role !== 'ADMIN') {
    return <div>Access Denied</div>;
  }

  const logs = await prisma.auditLog.findMany({
    orderBy: { changedAt: 'desc' },
    take: 100,
  });

  return (
    <div>
      <h1>Audit Logs</h1>
      <table>
        {/* Render audit logs */}
      </table>
    </div>
  );
}
```

### Important Considerations

⚠️ **Performance Impact:**

- Audit triggers add overhead to every write operation
- Only audit sensitive tables (users, payments, consultant profiles)
- Consider archiving old audit logs (>90 days) to a separate table

⚠️ **Storage:**

- JSON columns can grow large
- Consider retention policies (e.g., delete logs older than 1 year)
- Monitor database size growth

⚠️ **Privacy/GDPR:**

- Audit logs contain personal data
- Include audit logs in user data deletion requests
- Document audit log retention in privacy policy

---

## Best Practices

### RLS Policies

1. **Always Enable RLS**: Never disable RLS on tables with user data
2. **Test Policies**: Use `EXPLAIN` to verify policies work as expected
3. **Service Role**: Use service role key for backend operations that need to bypass RLS
4. **Least Privilege**: Grant minimum necessary permissions

### Triggers

1. **Keep Triggers Simple**: Complex logic should be in application code
2. **Avoid Infinite Loops**: Triggers that update the same table can cause loops
3. **Performance**: Triggers run on every operation - keep them fast
4. **Error Handling**: Triggers that fail will roll back the entire transaction

### Security

1. **Never Expose Service Role Key**: Only use in backend/server-side code
2. **Validate at Multiple Layers**: RLS + application validation + input sanitization
3. **Monitor Failed Attempts**: Log failed RLS policy checks
4. **Regular Audits**: Review policies quarterly

---

## Maintenance

### Regular Checks

**Monthly:**

- [ ] Review RLS policies for new tables
- [ ] Check for slow queries caused by RLS
- [ ] Verify trigger execution times

**Quarterly:**

- [ ] Audit unused policies
- [ ] Review and optimize complex policies
- [ ] Update documentation

**Yearly:**

- [ ] Full security audit
- [ ] Review audit log retention
- [ ] Update policies for new features

### Useful Queries

#### List All Policies

```sql
SELECT schemaname, tablename, policyname, roles, cmd, qual
FROM pg_policies
WHERE schemaname = 'public'
ORDER BY tablename, policyname;
```

#### List All Triggers

```sql
SELECT
  t.tgname as trigger_name,
  c.relname as table_name,
  p.proname as function_name
FROM pg_trigger t
JOIN pg_class c ON t.tgrelid = c.oid
JOIN pg_proc p ON t.tgfoid = p.oid
WHERE t.tgisinternal = false
  AND c.relnamespace = 'public'::regnamespace
ORDER BY c.relname, t.tgname;
```

#### Check RLS Status

```sql
SELECT tablename, rowsecurity
FROM pg_tables
WHERE schemaname = 'public'
ORDER BY tablename;
```

#### Test Policy as User

```sql
-- Set role to simulate a specific user
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims.sub = 'user-id-here';

-- Run your query
SELECT * FROM users WHERE id = 'user-id-here';

-- Reset
RESET ROLE;
```

---

## Additional Resources

- [Supabase RLS Documentation](https://supabase.com/docs/guides/auth/row-level-security)
- [PostgreSQL Trigger Documentation](https://www.postgresql.org/docs/current/sql-createtrigger.html)
- [PostgreSQL RLS Documentation](https://www.postgresql.org/docs/current/ddl-rowsecurity.html)

---

## Contact & Support

For questions about this documentation or database policies:

- Review this document
- Check Supabase Dashboard → Database → Policies
- Consult PostgreSQL documentation

**Last Reviewed:** October 10, 2025
