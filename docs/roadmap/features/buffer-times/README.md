# Buffer Times

## Overview

Allow consultants to set buffer times between appointments. Buffers provide breaks for preparation, follow-up notes, or personal time, improving session quality and preventing burnout.

### Value Proposition

- **Better Preparation**: Time to review client notes before sessions
- **Quality Follow-up**: Write notes and action items after sessions
- **Prevent Burnout**: Built-in breaks between intense discussions
- **Punctuality**: Cushion for sessions running slightly over

---

## User Stories

### Consultants

- As a consultant, I want to set buffer time before appointments
- As a consultant, I want to set buffer time after appointments
- As a consultant, I want different buffers for different service types
- As a consultant, I want the system to block buffer times from booking

### Consultees

- As a consultee, I should not see buffer times as bookable slots
- As a consultee, I want to see accurate availability without manual adjustments

---

## Technical Architecture

### Database Schema

**Add fields to ConsultantProfile:**

```prisma
model ConsultantProfile {
  // Existing fields...

  // NEW: Buffer time settings
  bufferBeforeMinutes Int @default(0)    // Minutes before each session
  bufferAfterMinutes  Int @default(15)   // Minutes after each session
}
```

**Option B: Per-plan buffers (More flexibility)**

```prisma
model ConsultationPlan {
  // Existing fields...

  // NEW: Plan-specific buffers (override profile defaults)
  bufferBeforeMinutes Int?
  bufferAfterMinutes  Int?
}

model SubscriptionPlan {
  // Same addition
  bufferBeforeMinutes Int?
  bufferAfterMinutes  Int?
}
```

### Buffer Application Logic

```
┌─────────────────────────────────────────────────────────┐
│              BUFFER TIME VISUALIZATION                   │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  Without Buffers:                                       │
│  ─────────────────                                      │
│                                                         │
│  09:00│██████████│10:00│██████████│11:00│██████████│   │
│       │ Session 1│     │ Session 2│     │ Session 3│   │
│                                                         │
│  With 15-min Buffer After:                             │
│  ──────────────────────────                            │
│                                                         │
│  09:00│██████████│10:00│░░░│██████████│11:00│░░░│      │
│       │ Session 1│     │Buf│ Session 2│     │Buf│      │
│       │          │     │fer│          │     │fer│      │
│                                                         │
│  With 10-min Before + 15-min After:                    │
│  ──────────────────────────────────                    │
│                                                         │
│  09:00│░░│████████│10:05│░░░│░░│████████│11:20│░░░│    │
│       │Bf│Session1│     │Aft│Bf│Session2│     │Aft│    │
│                                                         │
│  Legend: ██ Session  ░░ Buffer (Blocked)               │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### Implementation

```typescript
// lib/availability/buffers.ts

interface BufferConfig {
  beforeMinutes: number;
  afterMinutes: number;
}

export function getEffectiveBuffers(
  consultantProfile: ConsultantProfile,
  plan?: ConsultationPlan | SubscriptionPlan,
): BufferConfig {
  // Plan-specific buffers override profile defaults
  return {
    beforeMinutes:
      plan?.bufferBeforeMinutes ?? consultantProfile.bufferBeforeMinutes ?? 0,
    afterMinutes:
      plan?.bufferAfterMinutes ?? consultantProfile.bufferAfterMinutes ?? 15,
  };
}

export function applyBuffersToSlots(
  availableSlots: TimeSlot[],
  buffers: BufferConfig,
  sessionDurationMinutes: number,
): TimeSlot[] {
  return availableSlots
    .map((slot) => {
      // Adjust slot to account for buffers
      const adjustedStart = addMinutes(slot.start, buffers.beforeMinutes);
      const adjustedEnd = subMinutes(slot.end, buffers.afterMinutes);

      // Check if slot is still valid after buffer application
      const effectiveDuration = differenceInMinutes(adjustedEnd, adjustedStart);

      if (effectiveDuration < sessionDurationMinutes) {
        // Slot too short after buffers, mark as unavailable
        return null;
      }

      return {
        ...slot,
        effectiveStart: adjustedStart,
        effectiveEnd: adjustedEnd,
      };
    })
    .filter(Boolean);
}

// When checking availability
export async function getAvailableSlots(
  consultantProfileId: string,
  date: Date,
  planId?: string,
): Promise<TimeSlot[]> {
  const profile = await prisma.consultantProfile.findUnique({
    where: { id: consultantProfileId },
  });

  const plan = planId
    ? await prisma.consultationPlan.findUnique({
        where: { id: planId },
      })
    : null;

  const buffers = getEffectiveBuffers(profile, plan);

  // Get raw availability slots
  const rawSlots = await getRawAvailabilitySlots(consultantProfileId, date);

  // Get existing appointments
  const existingAppointments = await getExistingAppointments(
    consultantProfileId,
    date,
  );

  // Block time including buffers around existing appointments
  const blockedSlots = existingAppointments.flatMap((apt) => {
    const aptBuffers = getEffectiveBuffers(profile, apt.plan);
    return {
      start: subMinutes(apt.startTime, aptBuffers.beforeMinutes),
      end: addMinutes(apt.endTime, aptBuffers.afterMinutes),
    };
  });

  // Remove blocked times from available slots
  const availableAfterBlocking = subtractBlockedTimes(rawSlots, blockedSlots);

  // Apply buffers for new bookings
  const sessionDuration = plan?.duration ?? 60;
  return applyBuffersToSlots(availableAfterBlocking, buffers, sessionDuration);
}

// When creating a new appointment
export async function validateBookingWithBuffers(
  consultantProfileId: string,
  slotStart: Date,
  slotEnd: Date,
  planId?: string,
): Promise<{ valid: boolean; reason?: string }> {
  const profile = await prisma.consultantProfile.findUnique({
    where: { id: consultantProfileId },
  });

  const plan = planId
    ? await prisma.consultationPlan.findUnique({
        where: { id: planId },
      })
    : null;

  const buffers = getEffectiveBuffers(profile, plan);

  // Calculate the full blocked window including buffers
  const bufferStart = subMinutes(slotStart, buffers.beforeMinutes);
  const bufferEnd = addMinutes(slotEnd, buffers.afterMinutes);

  // Check for conflicts
  const conflictingAppointments = await prisma.slotOfAppointment.findMany({
    where: {
      appointment: {
        status: { in: ["SCHEDULED", "TENTATIVE"] },
        OR: [
          { consultation: { consultationPlan: { consultantProfileId } } },
          { subscription: { subscriptionPlan: { consultantProfileId } } },
          // ... webinar, class
        ],
      },
      OR: [
        // New booking's buffer overlaps with existing appointment
        {
          startTime: { lt: bufferEnd },
          endTime: { gt: bufferStart },
        },
      ],
    },
  });

  if (conflictingAppointments.length > 0) {
    return {
      valid: false,
      reason:
        "This time slot conflicts with another appointment or buffer time.",
    };
  }

  return { valid: true };
}
```

### API Endpoints

```
GET /api/consultants/[id]/settings/buffers
  Returns: { bufferBeforeMinutes, bufferAfterMinutes }

PATCH /api/consultants/[id]/settings/buffers
  Body: { bufferBeforeMinutes?, bufferAfterMinutes? }
  Updates: Buffer settings

GET /api/consultants/[id]/availability?planId=xxx&date=2024-12-09
  Returns: Available slots with buffers applied
```

---

## UI/UX Design

### Buffer Settings (Consultant Dashboard)

```
┌─────────────────────────────────────────────────────────┐
│  Availability Settings                                  │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  Buffer Times                                           │
│  ─────────────────────────────────────────────────────  │
│                                                         │
│  Add buffer time between appointments to prepare        │
│  or decompress between sessions.                        │
│                                                         │
│  Before each session:                                   │
│  ┌─────────────────────────────────────────────────────┐│
│  │ [──────●────────────────────────────────] 10 min   ││
│  │  0    5    10    15    20    25    30              ││
│  └─────────────────────────────────────────────────────┘│
│  Use this time to review client notes and prepare.     │
│                                                         │
│  After each session:                                    │
│  ┌─────────────────────────────────────────────────────┐│
│  │ [─────────────●─────────────────────────] 15 min   ││
│  │  0    5    10    15    20    25    30              ││
│  └─────────────────────────────────────────────────────┘│
│  Use this time to write follow-up notes.               │
│                                                         │
│  Preview:                                               │
│  ─────────────────────────────────────────────────────  │
│                                                         │
│  With a 60-minute session:                             │
│                                                         │
│  │ 10m │    60 min Session    │ 15m │                  │
│  │Buffer│                      │Buffer│                 │
│  │Before│                      │After │                 │
│                                                         │
│  Total blocked time: 85 minutes per session            │
│                                                         │
│  [Save Changes]                                         │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### Availability Calendar with Buffers

```
┌─────────────────────────────────────────────────────────┐
│  Your Availability - Monday, Dec 9                      │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  ┌──────────────────────────────────────────────────┐  │
│  │ 09:00  ████████████████████████  Available       │  │
│  │ 10:00  ░░░░ Buffer before                        │  │
│  │ 10:10  ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓  John Doe       │  │
│  │ 11:10  ░░░░░░ Buffer after                       │  │
│  │ 11:25  ████████████████████████  Available       │  │
│  │ 12:00  ████████████████████████  Available       │  │
│  │ 13:00  ░░░░ Buffer before                        │  │
│  │ 13:10  ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓  Jane Smith     │  │
│  │ 14:10  ░░░░░░ Buffer after                       │  │
│  │ 14:25  ████████████████████████  Available       │  │
│  └──────────────────────────────────────────────────┘  │
│                                                         │
│  Legend:  ████ Available  ▓▓▓▓ Booked  ░░░░ Buffer    │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### Consultee View (Booking Calendar)

```
┌─────────────────────────────────────────────────────────┐
│  Book with Priya Sharma                                 │
│  Monday, Dec 9                                          │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  Available times:                                       │
│                                                         │
│  Morning                                                │
│  [09:00]  [09:30]                                       │
│                                                         │
│  Afternoon                                              │
│  [11:30]  [12:00]  [12:30]                             │
│  [14:30]  [15:00]  [15:30]                             │
│                                                         │
│  (Buffer times are automatically excluded)              │
│                                                         │
└─────────────────────────────────────────────────────────┘

Note: Consultees see only available slots.
Buffer times are invisible to them - they just
see that 10:00-11:25 and 13:00-14:25 are unavailable.
```

---

## Implementation Approach

### Phase 1: Profile-Level Buffers

1. Add buffer fields to ConsultantProfile
2. Build settings UI
3. Apply buffers in availability calculation
4. Block buffer times from booking

### Phase 2: Visual Representation

1. Show buffers on consultant's calendar view
2. Add legend and explanation
3. Preview impact on availability

### Phase 3: Plan-Level Buffers (Optional)

1. Add buffer fields to plan models
2. Allow different buffers per service type
3. UI for per-plan configuration

### Phase 4: Calendar Sync Integration

1. Include buffer blocks in calendar exports
2. Sync buffers to Google/Outlook Calendar
3. Mark as "busy" with custom title

---

## Dependencies

### Depends On

- ConsultantProfile model
- SlotOfAvailability models
- Booking flow

### Features That Depend On This

- **Calendar Sync** - Export buffers as blocked time

---

## Edge Cases

1. **Consecutive bookings**: Merge overlapping buffers (don't double-count)
2. **Very short slots**: Slot may become too short after buffers
3. **Buffer longer than slot**: Validate buffer doesn't exceed availability window
4. **Existing appointments**: Apply buffers retroactively or only to new bookings?
5. **Webinars/Classes**: May need different (or no) buffers since they're group events

---

## Recommendations

### Default Values

- **Before buffer**: 0-10 minutes (preparation)
- **After buffer**: 10-15 minutes (notes, break)

### By Service Type

- **Consultation**: 10 before, 15 after
- **Subscription session**: 5 before, 10 after (recurring, less prep)
- **Webinar**: 15 before (tech setup), 0 after
- **Class**: 10 before, 10 after
