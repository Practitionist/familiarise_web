# Collaborator Permissions

## Overview

The permission system controls what collaborators can do on plans they're invited to. Permissions are role-based with optional JSON overrides per collaborator.

**File**: `lib/collaborators/permissions.ts`

---

## Permission Types

```typescript
type Permission =
  | "edit"        // Edit plan details (title, description, etc.)
  | "publish"     // Publish/unpublish the plan
  | "invite"      // Invite other collaborators
  | "analytics"   // View analytics and stats
  | "manage"      // Manage participants and waitlists
  | "schedule"    // Create events and set timings (HOST-ONLY, never granted to collaborators)
```

---

## Default Role Permissions

### Webinar Roles

| Permission | CO_HOST | MODERATOR | GUEST_SPEAKER | TECHNICAL_SUPPORT |
|------------|---------|-----------|---------------|-------------------|
| edit | Yes | No | No | No |
| publish | Yes | No | No | No |
| invite | Yes | No | No | No |
| analytics | Yes | Yes | No | No |
| manage | Yes | Yes | No | No |
| schedule | **No** | **No** | **No** | **No** |

### Class Roles

| Permission | CO_INSTRUCTOR | TEACHING_ASSISTANT | GUEST_LECTURER | CONTENT_CREATOR |
|------------|---------------|-------------------|----------------|-----------------|
| edit | Yes | No | No | Yes |
| publish | Yes | No | No | No |
| invite | Yes | No | No | No |
| analytics | Yes | Yes | No | No |
| manage | Yes | Yes | No | No |
| schedule | **No** | **No** | **No** | **No** |

**Scheduling is always host-only.** No collaborator role grants scheduling permission. Only the plan owner can create events, set times, and manage slots.

---

## Permission Checking

### Functions

```typescript
// Check if a consultant has a specific permission on a webinar plan
checkWebinarPermission(
  consultantProfileId: string,
  webinarPlanId: string,
  permission: Permission
): Promise<boolean>

// Check if a consultant has a specific permission on a class plan
checkClassPermission(
  consultantProfileId: string,
  classPlanId: string,
  permission: Permission
): Promise<boolean>
```

### Logic

```
1. Is the consultant the plan owner?
   → YES: All permissions granted (including schedule)

2. Is the consultant an ACCEPTED collaborator?
   → NO: No permissions

3. Does the collaborator have custom permissions JSON?
   → YES: Use custom permissions
   → NO: Use role defaults

4. Does the role/custom grant the requested permission?
   → Return true/false
```

---

## Custom Permission Overrides

The `permissions` field on `WebinarCollaborator` / `ClassCollaborator` is an optional JSON column. When set, it overrides the role defaults entirely.

### Schema

```json
{
  "edit": true,
  "publish": false,
  "invite": false,
  "analytics": true,
  "manage": true
}
```

### Use Case

A host invites someone as GUEST_SPEAKER (which by default has no permissions), but wants to give them analytics access:

```json
// WebinarCollaborator.permissions
{
  "analytics": true
}
```

When `permissions` JSON exists:
- Only the permissions listed as `true` are granted
- Missing keys are treated as `false`
- Role defaults are ignored entirely

---

## Implementation Pattern

Permissions are checked in API route handlers and server actions:

```typescript
// Example: Before allowing plan edit
import { checkWebinarPermission } from "@/lib/collaborators/permissions";

export async function PUT(request, { params }) {
  const { webinarPlanId } = await params;
  const session = await auth.api.getSession({ headers: request.headers });

  // Get consultant profile ID from session
  const profile = await getConsultantProfile(session.user.id);

  const canEdit = await checkWebinarPermission(
    profile.id,
    webinarPlanId,
    "edit"
  );

  if (!canEdit) {
    return NextResponse.json(
      { error: "You don't have permission to edit this plan" },
      { status: 403 }
    );
  }

  // ... proceed with edit
}
```

---

## Host vs Collaborator Capability Summary

```
┌────────────────────────────────┬─────────┬──────────────┐
│ Capability                     │ Host    │ Collaborator │
├────────────────────────────────┼─────────┼──────────────┤
│ Create the plan                │ ✓       │ ✗            │
│ Edit plan details              │ ✓       │ Role-based   │
│ Publish / unpublish            │ ✓       │ Role-based   │
│ Create events (schedule)       │ ✓       │ ✗ (NEVER)    │
│ Set event times                │ ✓       │ ✗ (NEVER)    │
│ Manage participant slots       │ ✓       │ Role-based   │
│ Invite collaborators           │ ✓       │ Role-based   │
│ Remove collaborators           │ ✓       │ ✗            │
│ View analytics                 │ ✓       │ Role-based   │
│ Join video call                │ ✓       │ ✓            │
│ Chat in collaborator channel   │ ✓       │ ✓            │
│ Accept/decline own invitation  │ N/A     │ ✓            │
│ Receive earnings               │ ✓       │ ✓            │
│ Delete the plan                │ ✓       │ ✗            │
└────────────────────────────────┴─────────┴──────────────┘
```
