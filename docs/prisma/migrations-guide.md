# Prisma Migrations Guide

A comprehensive guide for developers working with Prisma migrations in this project. This document covers what's possible, what's dangerous, and lessons learned from production issues.

## Table of Contents

- [Quick Reference: Safe vs Dangerous Operations](#quick-reference-safe-vs-dangerous-operations)
- [Understanding Migration Flow](#understanding-migration-flow)
- [What You Can Do WITHOUT Migrations](#what-you-can-do-without-migrations)
- [What REQUIRES Migrations](#what-requires-migrations)
- [Production Data Considerations](#production-data-considerations)
- [Real Problems We've Faced](#real-problems-weve-faced)
- [Migration Commands Reference](#migration-commands-reference)
- [Best Practices](#best-practices)
- [Troubleshooting](#troubleshooting)

---

## Quick Reference: Safe vs Dangerous Operations

### Safe (No Data Loss)

| Operation | Migration Required? | Notes |
|-----------|---------------------|-------|
| Add new model | Yes | Safe, creates new table |
| Add optional field (`String?`) | Yes | Safe, existing rows get `NULL` |
| Add field with default (`@default()`) | Yes | Safe, existing rows get default value |
| Add new index | Yes | Safe, just creates index |
| Rename model/field | Yes | **Use `@@map`/`@map` to avoid data loss** |
| Add new enum value | Yes | Safe in PostgreSQL |
| Change `@updatedAt` behavior | No | Prisma client change only |

### Dangerous (Potential Data Loss)

| Operation | Risk Level | What Happens |
|-----------|------------|--------------|
| Remove model | HIGH | Table and ALL data deleted |
| Remove field | HIGH | Column and data deleted |
| Make optional field required | MEDIUM | Fails if NULLs exist |
| Change field type | HIGH | May fail or lose precision |
| Remove enum value | HIGH | Fails if value is in use |
| Rename without `@map` | HIGH | Creates new column, drops old one |

### Requires Manual Migration

| Operation | Why |
|-----------|-----|
| Data transformation | Prisma can't know your business logic |
| Splitting/merging tables | Complex data movement |
| Changing relation type (1:1 to 1:N) | Structural change |

---

## Understanding Migration Flow

```
Schema Change → prisma migrate dev → SQL Generated → Applied to DB
                      ↓
              Migration file created in prisma/migrations/
```

### Development vs Production

```bash
# Development - interactive, can reset
npx prisma migrate dev

# Production - non-interactive, fails on issues
npx prisma migrate deploy
```

**Critical difference:** `migrate dev` can prompt to reset the database. `migrate deploy` will FAIL if there are issues, protecting production data.

---

## What You Can Do WITHOUT Migrations

These changes only affect the Prisma Client, not the database:

### 1. Client-Side Validations

```prisma
// These don't create database constraints
model User {
  email String // No @db.VarChar limit = no DB change needed
}
```

### 2. Relation Names

```prisma
// Changing relation names doesn't affect DB
topics Topic[] @relation("TopicToClassPlan")  // Can rename freely
topics Topic[] @relation("ClassPlanTopics")   // Just regenerate client
```

**BUT:** The implicit join table name IS affected by relation order. See [Real Problems](#1-implicit-many-to-many-table-naming-mismatch).

### 3. Virtual/Computed Fields in Application Code

Anything computed in your application code, not stored in DB.

### 4. Index Names (with `@@index`)

Changing index names requires migration, but doesn't affect data.

---

## What REQUIRES Migrations

### Adding Fields

```prisma
// SAFE: Optional field
model User {
  bio String?  // Existing rows get NULL
}

// SAFE: Field with default
model User {
  isActive Boolean @default(true)  // Existing rows get true
}

// DANGEROUS: Required field without default
model User {
  requiredField String  // FAILS if table has data!
}
```

**Solution for required fields on existing tables:**

```prisma
// Step 1: Add as optional
bio String?

// Step 2: Run data migration to populate
// Step 3: Change to required
bio String
```

### Changing Field Types

```prisma
// Generally DANGEROUS
age Int → age String  // Requires data conversion

// Safe narrowing (if data fits)
name String → name String @db.VarChar(255)  // OK if all values < 255 chars
```

### Enum Changes

```prisma
enum Status {
  PENDING
  ACTIVE
  COMPLETED  // Adding is SAFE
  // Removing PENDING would FAIL if any row uses it
}
```

---

## Production Data Considerations

### Before ANY Migration on Production

1. **ALWAYS backup the database first**
2. **Test on a staging environment with production-like data**
3. **Review the generated SQL** (`prisma migrate diff`)
4. **Have a rollback plan**

### What Happens to Existing Data?

| Schema Change | Existing Data |
|---------------|---------------|
| Add optional column | Gets `NULL` |
| Add column with `@default(x)` | Gets `x` |
| Add required column (no default) | **MIGRATION FAILS** |
| Drop column | **DATA DELETED** |
| Drop table | **ALL TABLE DATA DELETED** |
| Rename column (without @map) | **DATA DELETED** (new column created) |
| Change type (Int → String) | Converted if possible, else fails |

### Safe Renaming Pattern

```prisma
// DON'T do this (loses data):
// oldName String → newName String

// DO this instead:
model User {
  newName String @map("old_name")  // Maps to existing column
  @@map("users")                   // Maps to existing table
}
```

---

## Real Problems We've Faced

### 1. Implicit Many-to-Many Table Naming Mismatch

**Problem:** Prisma generates implicit join table names alphabetically, but our database had a different name.

```prisma
// Schema
model ClassPlan {
  topics Topic[] @relation("TopicToClassPlan")
}

model Topic {
  classPlans ClassPlan[] @relation("TopicToClassPlan")
}
```

**Expected table:** `_ClassPlanToTopic` (alphabetical: C before T)
**Actual table:** `_TopicToClassPlan`

**Error:**
```
PrismaClientKnownRequestError:
The table `public._ClassPlanToTopic` does not exist in the current database.
```

**Root Cause:** The table was likely created manually or through an older migration with different naming.

**Fix:**
```sql
ALTER TABLE "_TopicToClassPlan" RENAME TO "_ClassPlanToTopic";
```

**Lesson:** Always let Prisma generate join tables, or use explicit many-to-many with a join model.

### 2. Date Serialization in API Validation

**Problem:** Zod schemas expected `Date` objects, but JSON serialization converts dates to ISO strings.

```typescript
// Schema expected Date
const ClassContentSchema = z.object({
  createdAt: z.date().optional(),
  updatedAt: z.date().optional(),
});

// But JSON.stringify converts to strings:
// { createdAt: "2024-01-15T10:30:00.000Z" }  // String, not Date!
```

**Error:**
```
Validation Error: Expected date, received string
path: ['classContents', 0, 'createdAt']
```

**Fix:** Create separate input schemas that omit Prisma-managed fields:

```typescript
const ClassContentInputSchema = ClassContentSchema.omit({
  createdAt: true,
  updatedAt: true,
  classPlanId: true,  // Also Prisma-managed
});
```

**Lesson:** API input schemas should NOT include `createdAt`, `updatedAt`, or relation IDs that Prisma manages automatically.

### 3. Migration Drift Between Environments

**Problem:** Local migrations don't match production database state.

**Symptoms:**
- `prisma migrate status` shows "Database schema is up to date!"
- But queries fail because tables/columns are missing

**Causes:**
- Manual SQL changes in production
- Migrations applied in different order
- Skipped migrations

**Fix:**
```bash
# Check actual drift
npx prisma migrate diff --from-schema-datamodel prisma/schema.prisma --to-url $DATABASE_URL

# If needed, baseline the database
npx prisma migrate resolve --applied "migration_name"
```

### 4. Nullable vs Optional Confusion

**Problem:** Confusing TypeScript optional (`?`) with database nullable.

```prisma
// These are DIFFERENT:
field String?           // Database: NULL allowed, TypeScript: string | null
field String @default() // Database: NOT NULL with default, TypeScript: string
```

**In queries:**
```typescript
// This fails if field is required in DB but optional in schema
await prisma.user.create({
  data: { name: "John" }  // Missing required field!
});
```

### 5. Cascade Delete Surprises

**Problem:** Deleting a parent record unexpectedly deleted child records.

```prisma
model ClassPlan {
  classes Class[]  // Default: cascade delete!
}

model Class {
  classPlan ClassPlan @relation(fields: [classPlanId], references: [id])
  // Missing: onDelete: SetNull or Restrict
}
```

**Fix:** Always explicitly set `onDelete` behavior:

```prisma
model Class {
  classPlan ClassPlan @relation(fields: [classPlanId], references: [id], onDelete: Restrict)
}
```

---

## Migration Commands Reference

### Daily Development

```bash
# Create and apply migration
npx prisma migrate dev --name descriptive_name

# Just generate migration without applying
npx prisma migrate dev --create-only

# Reset database (DELETES ALL DATA)
npx prisma migrate reset

# Generate Prisma Client without migration
npx prisma generate
```

### Production Deployment

```bash
# Apply pending migrations (non-interactive)
npx prisma migrate deploy

# Check migration status
npx prisma migrate status

# Mark migration as applied (for baselining)
npx prisma migrate resolve --applied "20240115_migration_name"

# Mark migration as rolled back
npx prisma migrate resolve --rolled-back "20240115_migration_name"
```

### Debugging

```bash
# See what SQL would be generated
npx prisma migrate diff \
  --from-schema-datamodel prisma/schema.prisma \
  --to-url "$DATABASE_URL" \
  --script

# Validate schema without migrating
npx prisma validate

# Format schema file
npx prisma format
```

---

## Best Practices

### 1. Never Edit Migration Files After They're Committed

Once a migration is in git/applied to any environment, treat it as immutable.

### 2. Use Descriptive Migration Names

```bash
# Good
npx prisma migrate dev --name add_user_profile_fields
npx prisma migrate dev --name create_notification_preferences_table

# Bad
npx prisma migrate dev --name update
npx prisma migrate dev --name fix
```

### 3. Small, Focused Migrations

One logical change per migration. Easier to debug and rollback.

### 4. Always Use `@map` for Renames

```prisma
// Preserves data
model User {
  displayName String @map("name")  // Column stays "name" in DB
}
```

### 5. Test Migrations with Production-Like Data

```bash
# Dump production structure (not data) to test
pg_dump --schema-only production_db > schema.sql
```

### 6. Explicit Join Tables for Complex Many-to-Many

Instead of implicit:
```prisma
model Class {
  topics Topic[]
}
```

Use explicit for more control:
```prisma
model ClassTopic {
  id        String    @id @default(cuid())
  class     ClassPlan @relation(fields: [classId], references: [id])
  classId   String
  topic     Topic     @relation(fields: [topicId], references: [id])
  topicId   String
  createdAt DateTime  @default(now())

  @@unique([classId, topicId])
}
```

### 7. Document Breaking Changes

Add comments in migration files explaining why changes were made.

---

## Troubleshooting

### "Migration failed to apply cleanly"

```bash
# Check what's different
npx prisma migrate diff --from-migrations ./prisma/migrations --to-schema-datamodel ./prisma/schema.prisma

# If safe, mark as applied
npx prisma migrate resolve --applied "migration_name"
```

### "Table X does not exist"

1. Check if table name matches (case-sensitive in PostgreSQL)
2. Check if implicit join table naming matches
3. Verify migrations are applied: `npx prisma migrate status`

### "Column X cannot be cast to type Y"

Data type change isn't compatible. Need multi-step migration:
1. Add new column with new type
2. Migrate data: `UPDATE table SET new_col = old_col::new_type`
3. Drop old column
4. Rename new column

### "Cannot drop column, constraint depends on it"

```sql
-- Find dependent constraints
SELECT conname FROM pg_constraint WHERE conrelid = 'table_name'::regclass;

-- Drop constraint first, then column
```

---

## Related Documentation

- [Prisma Migrate Docs](https://www.prisma.io/docs/concepts/components/prisma-migrate)
- [Prisma Schema Reference](https://www.prisma.io/docs/reference/api-reference/prisma-schema-reference)
- [Supabase + Prisma Guide](https://supabase.com/docs/guides/integrations/prisma)
