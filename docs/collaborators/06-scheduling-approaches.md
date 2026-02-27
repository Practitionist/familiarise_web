# Collaborator Scheduling Approaches

This document outlines three approaches to collaborator scheduling visibility and control, from simplest (current) to most complex (future).

---

## 1. View-Only (Current MVP)

### What We Implemented

Collaborators with **ACCEPTED** status see a read-only schedule section on each active collaboration card in the Collaborations dashboard page.

### What Collaborators See

**Webinar collaborations:**

- Event status badge (Scheduled / Live) and tentative indicator
- Event date and time (from the first upcoming slot)
- Duration (from plan's `durationInHours`)
- Participant count vs. max capacity
- Plan owner name
- Count of additional upcoming events ("+N more events")

**Class collaborations:**

- Class status badge (Scheduled / In Progress)
- Scheduling period (start date to end date)
- Session count (completed/scheduled vs. total from plan)
- Session frequency and duration (e.g., "1h/session, 2x/week")
- Participant count vs. max capacity
- Next upcoming session date and time

### How It Works

**Backend** (`lib/collaborators/service.ts`):

- `getMyCollaborations` expanded to include nested `webinars` / `classes` with their `appointment` and `slotsOfAppointment` data
- Only fetches events with status `SCHEDULED` or `IN_PROGRESS`
- Limited to 5 most recent events per plan
- Includes plan owner via `consultantProfile.user`

**Frontend** (`components/collaborators/InvitationsPanel.tsx`):

- Active collaboration cards are clickable to expand/collapse a "Schedule" section
- `WebinarSchedule` and `ClassSchedule` components render event details in a grid layout
- Handles edge cases: no events scheduled, event exists but no time slot, class with no sessions yet

### Edge Cases Handled

| Scenario                                          | Display                             |
| ------------------------------------------------- | ----------------------------------- |
| No webinar events exist                           | "No events scheduled yet"           |
| Webinar exists but no appointment/slot            | "Event exists but no time slot set" |
| No class instances exist                          | "No classes scheduled yet"          |
| Class exists but no scheduling period or sessions | "Sessions not yet scheduled"        |

---

## 2. View + Suggest (Future Option)

### Concept

Collaborators can **view** the schedule (as above) and additionally **suggest** schedule changes. The plan owner reviews and approves/rejects suggestions. This preserves host authority while giving collaborators a voice.

### Required DB Changes

New model:

```prisma
model ScheduleSuggestion {
  id          String   @id @default(cuid())
  type        SuggestionType
  status      SuggestionStatus @default(PENDING)

  // What they're suggesting
  suggestedStartsAt DateTime?
  suggestedEndsAt   DateTime?
  reason            String?

  // Who suggested it
  suggestedByProfileId String
  suggestedByProfile   ConsultantProfile @relation(fields: [suggestedByProfileId], references: [id])

  // What plan/event it's for
  webinarPlanId String?
  classPlanId   String?

  // Owner response
  respondedAt   DateTime?
  responseNote  String?

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}

enum SuggestionType {
  NEW_EVENT
  RESCHEDULE
  CANCEL
}

enum SuggestionStatus {
  PENDING
  APPROVED
  REJECTED
}
```

### Workflow

1. Collaborator clicks "Suggest Change" next to a scheduled event
2. Modal opens with date/time picker and a reason field
3. Suggestion is created with `PENDING` status
4. Notification sent to plan owner via Novu
5. Owner sees suggestion in their Event Planner or a dedicated "Suggestions" tab
6. Owner approves (auto-applies the change) or rejects (with optional note)
7. Collaborator receives notification of the outcome

### Notification Integration

- `SCHEDULE_SUGGESTION_CREATED` - sent to plan owner
- `SCHEDULE_SUGGESTION_RESOLVED` - sent to suggesting collaborator

---

## 3. Full Editing for Senior Roles (Future Option)

### Concept

Senior collaborators (CO_HOST for webinars, CO_INSTRUCTOR for classes) get direct scheduling permissions. They can create, reschedule, and cancel events without owner approval.

### Permission Model

Add a `canScheduleOnPlan` permission check:

```typescript
function canScheduleOnPlan(
  role: string,
  planType: "webinar" | "class",
): boolean {
  if (planType === "webinar") {
    return role === "CO_HOST";
  }
  return role === "CO_INSTRUCTOR";
}
```

### Required Changes

1. **Authorization layer**: PATCH/POST/DELETE endpoints for events need to check collaborator permissions alongside owner auth
2. **Event Planner tab**: Add a filtered view showing only plans the collaborator has scheduling access to
3. **Optimistic locking**: Add a `version` field to events to handle race conditions when multiple people edit
4. **Audit trail**: Log who created/modified each event for accountability

### Race Condition Considerations

- Two collaborators (or owner + collaborator) could try to schedule the same time slot
- Solution: Use database-level unique constraints on slot times per plan, plus optimistic locking with version checks
- Alternative: Use Prisma's `@@unique` constraint on `[appointmentId, startsAt]` in `SlotOfAppointment`

---

## Competitor Research

| Platform            | Scheduling Model                                                     |
| ------------------- | -------------------------------------------------------------------- |
| **Zoom**            | Only meeting host can schedule; co-hosts have in-meeting powers only |
| **Thinkific**       | Course admin can manage schedule; instructors cannot                 |
| **TopMate**         | Single-host model, no collaborator concept                           |
| **Google Calendar** | Shared calendars with granular read/write permissions per user       |
| **Calendly**        | Team events allow round-robin but scheduling is admin-controlled     |

**Industry consensus**: Most platforms keep scheduling as a host/admin-only action. Google Calendar's granular permission model is the closest analog to Approach 3, but it's designed for general calendaring, not event management.

**Recommendation**: Approach 1 (view-only) is the right MVP. Consider Approach 2 (suggest) if collaborator feedback indicates scheduling friction. Approach 3 should only be built if there's clear demand from power users running large multi-instructor programs.
