# Quick Start Guide

Welcome! This guide will help you understand the booking algorithm system in 15 minutes and get you productive quickly.

## 🎯 What Does This System Do?

The booking algorithm manages time slot allocation and validation for:

- **Consultations** - One-time sessions between consultee and consultant
- **Subscriptions** - Recurring sessions over weeks/months
- **Webinars** - One-time group sessions
- **Classes** - Recurring group sessions

## 🏗️ Core Concepts

### 1. Slots

A **slot** is a 30-minute time block stored in UTC.

```typescript
// Example slot
const slot = new Date("2025-01-15T10:00:00Z"); // 10:00 AM UTC
```

### 2. Appointments

An **appointment** groups multiple consecutive slots for a single session.

```typescript
// 1.5-hour consultation = 3 consecutive 30-min slots
const appointment = {
  slots: [
    "2025-01-15T10:00:00Z", // Slot 1
    "2025-01-15T10:30:00Z", // Slot 2
    "2025-01-15T11:00:00Z", // Slot 3
  ],
};
```

### 3. Allocation Modes

**Auto Mode** - System finds available slots automatically

```typescript
{
  isAuto: true;
}
```

**Manual Mode** - User selects specific slots

```typescript
{
  isAuto: false,
  slots: ["2025-01-15T10:00:00Z", "2025-01-15T10:30:00Z"]
}
```

**Requested Mode** - Uses consultee's pre-selected slots

```typescript
{
  isAuto: false,
  useRequestedSlots: true
}
```

## 🔄 Typical Flow

### Scenario: Book a 1-hour Consultation

```
1. Consultee creates consultation request
   ├─> System validates consultant availability
   └─> Consultee optionally selects preferred slots (tentative)

2. Consultant reviews request
   ├─> Opens validation dialog
   ├─> Selects time slots (or uses auto-allocation)
   └─> Frontend calls /validate endpoint

3. Frontend displays validation results
   ├─> Green: Available slots
   ├─> Red: Conflicts or outside availability
   └─> User confirms or adjusts

4. Frontend calls /allocate endpoint
   ├─> System creates appointment
   ├─> Marks consultant as booked
   └─> Updates request status to APPROVED
```

## 📡 API Endpoints

### Validate Slots

```http
POST /api/events/consultations/:id/validate
Content-Type: application/json

{
  "slots": [
    "2025-01-15T10:00:00Z",
    "2025-01-15T10:30:00Z"
  ]
}
```

**Response:**

```json
{
  "data": {
    "conflicts": [],
    "outsideAvailability": [],
    "validSlots": ["2025-01-15T10:00:00Z", "2025-01-15T10:30:00Z"]
  }
}
```

### Allocate Slots

```http
PATCH /api/events/consultations/:id/allocate
Content-Type: application/json

{
  "isAuto": false,
  "slots": [
    "2025-01-15T10:00:00Z",
    "2025-01-15T10:30:00Z"
  ]
}
```

**Response:**

```json
{
  "data": [
    {
      "id": "appt-123",
      "appointmentType": "CONSULTATION",
      "slotsOfAppointment": [...]
    }
  ],
  "warnings": []
}
```

## 🛠️ Key Files

### API Routes (8 endpoints)

```
app/api/events/
├── consultations/[consultationId]/
│   ├── allocate/route.ts
│   └── validate/route.ts
├── subscriptions/[subscriptionId]/
│   ├── allocate/route.ts
│   └── validate/route.ts
├── webinars/[webinarId]/
│   ├── allocate/route.ts
│   └── validate/route.ts
└── classes/[classId]/
    ├── allocate/route.ts
    └── validate/route.ts
```

### Services

```
utils/slotAllocation/
├── SlotAllocationService.ts      # Main allocation logic
├── SlotValidationService.ts      # Validation logic
├── SlotCalculationService.ts     # Slot math utilities
└── types.ts                       # TypeScript types
```

### Validation

```
schemas/slotAllocation/
└── validationSchemas.ts           # Zod schemas (type-safe)
```

### Database Models

```
prisma/schema.prisma
├── Consultation
├── Subscription
├── Webinar
├── Class
├── Appointment
└── Slot
```

## 🧪 Try It Yourself

###Step 1: Validate Slots

```typescript
// In your API route or service
import { validationRequestSchema } from "@/schemas/slotAllocation/validationSchemas";
import { SlotValidationService } from "@/utils/slotAllocation/SlotValidationService";

// Validate input
const body = validationRequestSchema.parse(await request.json());

// Check availability
const service = new SlotValidationService(prisma);
const result = await service.validate(
  "consultation",
  consultationId,
  body.slots.map((s) => new Date(s)),
  consultantProfile,
  { durationInHours: 1 },
);

// result.isValid tells you if slots are available
```

### Step 2: Allocate Slots

```typescript
import { allocationRequestSchema } from "@/schemas/slotAllocation/validationSchemas";
import { SlotAllocationService } from "@/utils/slotAllocation/SlotAllocationService";

// Validate input
const body = allocationRequestSchema.parse(await request.json());

// Allocate slots
const result = await SlotAllocationService.allocate({
  eventType: "consultation",
  eventId: consultationId,
  mode: body.isAuto ? "auto" : "manual",
  slots: body.slots,
});

if (result.success) {
  // Appointments created!
  console.log("Created appointments:", result.appointments);
}
```

## ✅ Validation Checklist

Before allocation succeeds, the system validates:

1. **Input Format** (Zod)
   - [ ] `isAuto` is boolean
   - [ ] `slots` are valid ISO datetime strings
   - [ ] `eventId` is valid UUID

2. **Business Rules** (SlotValidationService)
   - [ ] Slots are in the future
   - [ ] No conflicts with existing appointments
   - [ ] Slots match consultant's availability
   - [ ] Slots are consecutive (for multi-slot sessions)
   - [ ] Within scheduling period (if defined)

3. **Event-Specific Rules**
   - **Consultations**: Duration matches session length
   - **Subscriptions**: Weekly limits not exceeded
   - **Webinars**: Exactly 1 slot
   - **Classes**: Weekly distribution respected

## 🐛 Common Errors

### "Slot already booked"

**Cause**: Time range overlap with existing appointment
**Fix**: Check consultant's calendar, select different time

### "Slot count must be multiple of session duration"

**Cause**: 2-hour session needs 4 slots, but 5 provided
**Fix**: Ensure `slots.length % slotsPerSession === 0`

### "Slots must be consecutive"

**Cause**: Gap between selected slots
**Fix**: Select adjacent 30-min blocks

### "Weekly limit exceeded"

**Cause**: Subscription only allows 2 calls/week, trying to schedule 3
**Fix**: Distribute slots across weeks

See [Troubleshooting Guide](./08_TROUBLESHOOTING.md) for more solutions.

## 🎓 Next Steps

Now that you understand the basics:

1. **Deep Dive**: Read [Architecture](./02_ARCHITECTURE.md) for system design
2. **Event Types**: Study [Event Types Guide](./03_EVENT_TYPES.md) for differences
3. **Validation**: Master [Validation Layers](./04_VALIDATION_LAYERS.md)
4. **Testing**: Write tests using [Testing Guide](./09_TESTING_GUIDE.md)

## 💡 Pro Tips

1. **Always use Zod schemas** - They provide automatic type inference

   ```typescript
   const body = allocationRequestSchema.parse(data);
   // TypeScript knows: { isAuto: boolean; slots?: string[]; ... }
   ```

2. **Check validation before allocation** - Saves database round-trips

   ```typescript
   // Step 1: Validate (cheap)
   const validation = await validateSlots(...);
   if (!validation.isValid) return validation.errors;

   // Step 2: Allocate (expensive, writes to DB)
   const allocation = await allocate(...);
   ```

3. **Handle timezones carefully** - Store UTC, display local

   ```typescript
   // Store
   const utcSlot = new Date("2025-01-15T10:00:00Z");

   // Display
   const localTime = utcSlot.toLocaleString("en-US", {
     timeZone: consultant.currentTimezone,
   });
   ```

4. **Use transactions for atomicity** - SlotAllocationService does this automatically
   ```typescript
   await prisma.$transaction(async (tx) => {
     // Multiple operations - all succeed or all fail
   });
   ```

## 📚 Reference

- [API Reference](./06_API_REFERENCE.md) - Complete endpoint docs
- [Slot Calculations](./05_SLOT_CALCULATIONS.md) - Time math explained
- [Bug Fixes](./07_BUG_FIXES_CHANGELOG.md) - Recent improvements

---

**Questions?** Check the [Troubleshooting Guide](./08_TROUBLESHOOTING.md) or ask in #engineering-support.
