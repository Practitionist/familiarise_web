# Collaborator Stream.io Integration

## Overview

When a collaborator accepts an invitation, a private Stream.io messaging channel is auto-created for team coordination. This allows the host and all accepted collaborators to communicate before, during, and after events.

**File**: `actions/stream/chat/channel.action.ts` — `createCollaboratorChannel()`

---

## Channel Architecture

### Channel Naming Convention

The platform uses different channel ID patterns to distinguish channel purposes:

| Purpose                    | Channel ID Pattern               | Channel Type | Members                       |
| -------------------------- | -------------------------------- | ------------ | ----------------------------- |
| 1:1 Consultation           | `consultation-{consultationId}`  | `messaging`  | Consultant + consultee        |
| 1:1 Subscription           | `subscription-{subscriptionId}`  | `messaging`  | Consultant + consultee        |
| Webinar Event              | `webinar-{webinarId}`            | `team`       | Host + all participants       |
| Class Event                | `class-{classId}`                | `team`       | Host + all participants       |
| **Collaborator (Webinar)** | `collab-webinar-{webinarPlanId}` | `messaging`  | Host + accepted collaborators |
| **Collaborator (Class)**   | `collab-class-{classPlanId}`     | `messaging`  | Host + accepted collaborators |

### Why `messaging` type?

Collaborator channels use `messaging` (private, invitation-only) rather than `team` (open) because:

- Only the host and accepted collaborators should have access
- Participants should not see collaborator coordination
- Private channels prevent accidental information leakage

---

## Channel Creation Flow

### Trigger

A collaborator channel is created (or updated) when a collaborator **accepts** an invitation.

**Location**: `lib/collaborators/service.ts` — `respondToInvitation()`

```typescript
// When response is ACCEPTED:
if (response === "ACCEPTED") {
  try {
    const { createCollaboratorChannel } =
      await import("@/actions/stream/chat/channel.action");
    await createCollaboratorChannel(planType, planId);
  } catch (err) {
    console.error("Failed to create collaborator channel:", err);
    // Non-blocking: collaboration still accepted even if channel creation fails
  }
}
```

**Note**: Dynamic `import()` is used to avoid circular dependencies between the service layer and server actions.

### Channel Creation Logic

```
createCollaboratorChannel("webinar", planId)
        │
        ▼
  Query plan with:
    - consultantProfile.user.id (host)
    - collaborators where status = ACCEPTED
      └─ consultantProfile.user.id (each collaborator)
        │
        ▼
  Collect member IDs:
    [hostUserId, ...collaboratorUserIds]
        │
        ▼
  Skip if < 2 members
  (no channel needed if host is alone)
        │
        ▼
  createChannel({
    channelType: "messaging",
    channelId: "collab-webinar-{planId}",
    channelName: "{Plan Title} - Collaborators",
    members: allMemberIds,
    createdById: hostUserId,
    additionalData: {
      webinar_plan_id: planId,
      is_collaborator_channel: true,
    },
  })
```

### Idempotency

If the channel already exists (e.g., a second collaborator accepts), Stream.io's `getOrCreate` behavior updates the member list rather than failing. New members are added to the existing channel.

---

## Channel Type Inference

The `addMemberToChannel()` function in `channel.action.ts` infers channel type from the ID prefix:

```typescript
const channelType =
  channelId.startsWith("consultation-") ||
  channelId.startsWith("subscription-") ||
  channelId.startsWith("collab-")
    ? "messaging"
    : "team";
```

This ensures that when new members are added to collaborator channels, the correct Stream.io channel type is used.

---

## Channel Lifecycle

```
┌─────────────────────────────────────────────────────────────┐
│                COLLABORATOR CHANNEL LIFECYCLE                 │
│                                                              │
│  1. Collaborator A accepts invitation                        │
│     └─ Channel created: collab-webinar-{planId}              │
│        Members: [Host, Collaborator A]                       │
│                                                              │
│  2. Collaborator B accepts invitation                        │
│     └─ Channel updated (getOrCreate)                         │
│        Members: [Host, Collaborator A, Collaborator B]       │
│                                                              │
│  3. Team coordinates via private chat                        │
│     └─ Discuss content, logistics, timings                   │
│                                                              │
│  4. Host removes Collaborator B                              │
│     └─ Collaborator removed from BOTH:                       │
│        a) Event channel (webinar-{eventId} or               │
│           class-{eventId})                                    │
│        b) Plan-level collab channel                           │
│           (collab-webinar-{planId} or                         │
│            collab-class-{planId})                              │
│        Notification and Stream removal use independent        │
│        try/catch blocks -- one failure does not block the     │
│        other.                                                 │
│                                                              │
│  5. Channel persists for ongoing collaboration               │
│     └─ No auto-deletion                                      │
└─────────────────────────────────────────────────────────────┘
```

---

## Video Call Roles (Deferred)

Stream.io video calls support role-based permissions:

| Collaborator Role                   | Intended Stream Role | Status   |
| ----------------------------------- | -------------------- | -------- |
| CO_HOST / CO_INSTRUCTOR             | `host`               | Deferred |
| MODERATOR / TEACHING_ASSISTANT      | `moderator`          | Deferred |
| GUEST_SPEAKER / GUEST_LECTURER      | `speaker`            | Deferred |
| TECHNICAL_SUPPORT / CONTENT_CREATOR | `attendee`           | Deferred |

**Why deferred**: Video calls are currently created client-side using `call.getOrCreate()` in `lib/meeting.ts`. Assigning collaborator-specific roles requires either:

1. Server-side call creation (architectural change), or
2. Client-side role assignment after call creation (race conditions)

The foundation (collaborator data in the DB) is in place for a future implementation.

---

## Chat UI Integration

Collaborator channels appear in the consultant's chat interface. The channel ID prefix `collab-` allows the UI to:

1. Display these channels in a "Collaborations" section
2. Show the plan title as the channel name
3. Distinguish them from 1:1 consultation/subscription chats

### Channel Data

Each channel carries metadata in `additionalData`:

```json
{
  "webinar_plan_id": "clx...",
  "is_collaborator_channel": true
}
```

This enables the UI to:

- Link to the plan management page
- Show plan-specific context
- Filter/group channels by type
