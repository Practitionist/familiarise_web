# Database Changes Changelog

Track all database policy and trigger changes here.

---

## October 10, 2025 - Audit Triggers Removal

### Summary

Removed broken audit triggers that referenced non-existent `audit_logs` table, which was causing OAuth sign-in failures.

### Problem

- OAuth authentication failing with error: `The table 'audit_logs' does not exist in the current database`
- Error occurred during `prisma.user.update()` in NextAuth callback
- Audit triggers existed but the required `audit_logs` table was never created

### Investigation Results

**Affected Tables:**

- ✅ users
- ✅ Appointment
- ✅ ConsultantProfile
- ✅ ConsultantReview
- ✅ Consultation
- ✅ ConsulteeProfile
- ✅ Payment

**Triggers Found:**

```sql
audit_users_trigger
audit_appointment_trigger
audit_consultantprofile_trigger
audit_consultantreview_trigger
audit_consultation_trigger
audit_consulteeprofile_trigger
audit_payment_trigger
```

**Functions Found:**

```sql
audit_users_changes()
audit_appointment_changes()
audit_consultantprofile_changes()
audit_consultantreview_changes()
audit_consultation_changes()
audit_consulteeprofile_changes()
audit_payment_changes()
```

### Changes Made

**Removed Triggers:**

```sql
DROP TRIGGER IF EXISTS audit_users_trigger ON users;
DROP TRIGGER IF EXISTS audit_appointment_trigger ON "Appointment";
DROP TRIGGER IF EXISTS audit_consultantprofile_trigger ON "ConsultantProfile";
DROP TRIGGER IF EXISTS audit_consultantreview_trigger ON "ConsultantReview";
DROP TRIGGER IF EXISTS audit_consultation_trigger ON "Consultation";
DROP TRIGGER IF EXISTS audit_consulteeprofile_trigger ON "ConsulteeProfile";
DROP TRIGGER IF EXISTS audit_payment_trigger ON "Payment";
```

**Removed Functions:**

```sql
DROP FUNCTION IF EXISTS audit_users_changes();
DROP FUNCTION IF EXISTS audit_appointment_changes();
DROP FUNCTION IF EXISTS audit_consultantprofile_changes();
DROP FUNCTION IF EXISTS audit_consultantreview_changes();
DROP FUNCTION IF EXISTS audit_consultation_changes();
DROP FUNCTION IF EXISTS audit_consulteeprofile_changes();
DROP FUNCTION IF EXISTS audit_payment_changes();
```

### Impact Assessment

**✅ No Negative Impact:**

- Audit logging was not implemented in Next.js app
- Audit logging was not implemented in Flutter app
- No application code referenced audit_logs table
- All application functionality continues to work

**✅ Positive Impact:**

- OAuth sign-in now works correctly
- No more database errors during user updates
- Cleaner database with only functional triggers

### Verification

**Tests Performed:**

- ✅ OAuth sign-in flow (Google provider)
- ✅ User profile updates
- ✅ Consultant profile operations
- ✅ Payment operations
- ✅ All CRUD operations on affected tables

**Database State After Changes:**

```sql
-- Verified no audit triggers remain
SELECT count(*) FROM pg_trigger
WHERE tgname LIKE 'audit_%'
  AND tgisinternal = false;
-- Result: 0

-- Verified active triggers still working
SELECT count(*) FROM pg_trigger
WHERE tgname LIKE 'update_%updated_at'
  AND tgisinternal = false;
-- Result: 31 (all updatedAt triggers intact)
```

### Documentation Created

Created comprehensive documentation in `docs/supabase/rls-policies-triggers/`:

1. **README.md** - Main documentation covering:
   - Incident report
   - Current RLS policies (50+ policies documented)
   - Active triggers (32 triggers documented)
   - How to implement audit logging properly
   - Best practices and maintenance procedures

2. **QUICK_REFERENCE.md** - Quick command reference:
   - Common SQL queries
   - RLS policy patterns
   - Trigger patterns
   - Testing procedures

3. **TROUBLESHOOTING.md** - Troubleshooting guide:
   - OAuth issues
   - RLS policy issues
   - Trigger failures
   - Performance problems
   - Connection issues

4. **CHANGELOG.md** - This file

### Recommendations

1. **If audit logging is needed in the future:**
   - Follow the implementation guide in README.md
   - Create `audit_logs` table via Prisma migration
   - Only audit sensitive tables (not all tables)
   - Add RLS policies to audit_logs table
   - Test thoroughly before deploying

2. **Be cautious with Supabase Dashboard:**
   - Don't enable audit features without full implementation
   - Test trigger creation in development first
   - Always create required tables before triggers

3. **For Flutter integration:**
   - Coordinate database changes between teams
   - Test on shared staging database first
   - Document any Flutter-specific triggers/policies

### Rollback Procedure

If audit triggers need to be restored (NOT recommended without audit_logs table):

```sql
-- DO NOT RUN unless audit_logs table exists!

-- Example restore for users table
CREATE OR REPLACE FUNCTION audit_users_changes()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO audit_logs (
    table_name, record_id, operation,
    old_values, new_values, changed_by, changed_at
  ) VALUES (
    'users',
    COALESCE(NEW.id, OLD.id)::text,
    TG_OP,
    CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE NULL END,
    CASE WHEN TG_OP IN ('INSERT', 'UPDATE') THEN to_jsonb(NEW) ELSE NULL END,
    auth.uid(),
    NOW()
  );
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER audit_users_trigger
  AFTER INSERT OR UPDATE OR DELETE ON users
  FOR EACH ROW
  EXECUTE FUNCTION audit_users_changes();
```

### Related Issues

- **Supabase Project**: pzmbxqdgibfkhjwzeprf
- **Region**: aws-0-ap-south-1
- **Shared with**: Flutter mobile application
- **Next.js Version**: 15.3.0
- **Prisma Version**: Check package.json
- **NextAuth Version**: Check package.json

---

## Template for Future Changes

Use this template when making database changes:

````markdown
## YYYY-MM-DD - [Change Title]

### Summary

Brief description of what changed and why.

### Problem (if applicable)

What issue was being addressed?

### Investigation (if applicable)

What was discovered during investigation?

### Changes Made

**SQL Commands:**

```sql
-- Commands executed
```
````

### Impact Assessment

**Positive Impact:**

- What improved?

**Potential Negative Impact:**

- What might break?
- Mitigation steps taken

### Verification

**Tests Performed:**

- [ ] Test 1
- [ ] Test 2

### Rollback Procedure

```sql
-- Commands to undo changes if needed
```

### Related

- Links to issues, PRs, or discussions

```

---

## Future Planned Changes

Document planned database changes here:

### Potential Future Enhancements

1. **Implement Proper Audit Logging**
   - Status: Not started
   - Priority: Low
   - Requires: audit_logs table, proper RLS policies
   - See: README.md implementation guide

2. **Add Admin-Specific Policies**
   - Status: Not started
   - Priority: Medium
   - Current: Some tables allow all authenticated users to modify
   - Goal: Restrict to ADMIN/STAFF roles

3. **Optimize RLS Policies for Performance**
   - Status: Not started
   - Priority: Low
   - Consider: Adding indexes, simplifying complex policies
   - Monitor: Query performance as user base grows

4. **Implement Soft Delete**
   - Status: Not started
   - Priority: Low
   - Tables: users, ConsultantProfile, etc.
   - Benefit: Data recovery, audit trail

---

## Notes

- All changes should be tested in development environment first
- Update this changelog for every database schema/policy change
- Include rollback procedures for all major changes
- Keep backup of current state before making changes
- Coordinate with Flutter team for shared Supabase project
```
