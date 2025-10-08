# Booking System UI Implementation Guide

**Version:** 2.0
**Last Updated:** January 2025
**Target Audience:** Frontend Developers

---

## Table of Contents

1. [Quick Start](#quick-start)
2. [Component Overview](#component-overview)
3. [User Flows](#user-flows)
4. [State Management](#state-management)
5. [UI States & Loading](#ui-states--loading)
6. [Error Handling](#error-handling)
7. [Accessibility](#accessibility)
8. [Styling Guidelines](#styling-guidelines)
9. [Testing Scenarios](#testing-scenarios)
10. [Troubleshooting](#troubleshooting)

---

## 1. Quick Start

### Prerequisites

- Read [ARCHITECTURE.md](./ARCHITECTURE.md) for business logic understanding
- Familiarize yourself with the database schema
- Understand the 4 event types and 3 allocation modes

### Key UI Components

| Component              | Location                              | Purpose                            |
| ---------------------- | ------------------------------------- | ---------------------------------- |
| `EventTimingsCalendar` | `(features)/appointments/components/` | Main dialog for managing timings   |
| `RequestedSlotsDialog` | `(features)/requests/components/`     | Approve consultee-requested slots  |
| `UnifiedCalendar`      | `(features)/shared/components/`       | Core calendar component (reusable) |
| `SafeUnifiedCalendar`  | `(features)/shared/components/`       | Error boundary wrapper             |

### Quick Integration Example

```typescript
import { EventTimingsCalendar } from '@/app/dashboard/consultant/[consultantId]/(features)/appointments/components/EventTimingsCalendar';

function AppointmentsList() {
  const [selectedAppointment, setSelectedAppointment] = useState(null);
  const [isDialogOpen, setIsDialogOpen] = useState(false);

  return (
    <>
      {appointments.map(appt => (
        <div key={appt.id} onClick={() => {
          setSelectedAppointment(appt);
          setIsDialogOpen(true);
        }}>
          Manage Timings
        </div>
      ))}

      {selectedAppointment && (
        <EventTimingsCalendar
          isOpen={isDialogOpen}
          onClose={() => setIsDialogOpen(false)}
          appointment={selectedAppointment}
        />
      )}
    </>
  );
}
```

---

## 2. Component Overview

### Component Hierarchy

```
┌─────────────────────────────────────────────────────────────┐
│ EventTimingsCalendar (Dialog)                               │
│ ┌─────────────────────────────────────────────────────────┐ │
│ │ DialogHeader                                            │ │
│ │ - Title: "Manage {EventType} Timings"                   │ │
│ │ - Description: Event-specific instructions              │ │
│ │ - Metadata: Plan type, sessions/week, duration          │ │
│ └─────────────────────────────────────────────────────────┘ │
│                                                               │
│ ┌─────────────────────────────────────────────────────────┐ │
│ │ SafeUnifiedCalendar (Error Boundary)                    │ │
│ │ ┌─────────────────────────────────────────────────────┐ │ │
│ │ │ UnifiedCalendar                                     │ │ │
│ │ │ ┌─────────────────────────────────────────────────┐ │ │ │
│ │ │ │ Calendar Header                                 │ │ │ │
│ │ │ │ [< Prev] [Week/Month Toggle] [Next >]          │ │ │ │
│ │ │ └─────────────────────────────────────────────────┘ │ │ │
│ │ │ ┌─────────────────────────────────────────────────┐ │ │ │
│ │ │ │ Calendar Grid (Week/Month View)                │ │ │ │
│ │ │ │ ┌─────┬─────┬─────┬─────┬─────┬─────┬─────┐   │ │ │ │
│ │ │ │ │ Sun │ Mon │ Tue │ Wed │ Thu │ Fri │ Sat │   │ │ │ │
│ │ │ │ ├─────┼─────┼─────┼─────┼─────┼─────┼─────┤   │ │ │ │
│ │ │ │ │08:00│     │     │     │     │     │     │   │ │ │ │
│ │ │ │ │08:30│ 🟢  │ 🟢  │ 🟢  │ ⬜️  │ 🟢  │ 🟢  │   │ │ │ │
│ │ │ │ │09:00│ 🔵  │ 🟢  │ 🟢  │ ⬜️  │ 🟢  │ 🟢  │   │ │ │ │
│ │ │ │ │09:30│ 🔵  │ ⬛️  │ ⬛️  │ ⬜️  │ 🟢  │ 🟢  │   │ │ │ │
│ │ │ │ └─────┴─────┴─────┴─────┴─────┴─────┴─────┘   │ │ │ │
│ │ │ │ Legend: 🟢 Available 🔵 Selected ⬛️ Booked      │ │ │ │
│ │ │ └─────────────────────────────────────────────────┘ │ │ │
│ │ │ ┌─────────────────────────────────────────────────┐ │ │ │
│ │ │ │ Footer (Progress Tracker)                       │ │ │ │
│ │ │ │ "✅ 5/26 calls scheduled | ⏳ 21 remaining"     │ │ │ │
│ │ │ └─────────────────────────────────────────────────┘ │ │ │
│ │ │ ┌─────────────────────────────────────────────────┐ │ │ │
│ │ │ │ Allocation Buttons                              │ │ │ │
│ │ │ │ [⚡ Auto Allocate] [✋ Manual] [Clear]          │ │ │ │
│ │ │ └─────────────────────────────────────────────────┘ │ │ │
│ │ └─────────────────────────────────────────────────────┘ │ │
│ └─────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

### UnifiedCalendar Props

```typescript
interface UnifiedCalendarProps {
  // Required
  consultantId: string;
  eventType: "consultation" | "subscription" | "webinar" | "class";
  mode: "view" | "select" | "allocate";

  // Event-specific
  eventId?: string; // Required for allocation
  durationInHours?: number; // For consultations/webinars (total)
  sessionDurationInHours?: number; // For subscriptions/classes (per session)
  durationInMonths?: number; // For subscriptions/classes
  callsPerWeek?: number; // For subscriptions/classes

  // Boundaries (for subscriptions/classes)
  allowedStart?: Date; // Earliest selectable date
  allowedEnd?: Date; // Latest selectable date

  // UI
  showAllocationButtons?: boolean;
  preSelectedSlots?: TimeSlot[];
  requestedSlots?: TimeSlot[];
  className?: string;

  // Callbacks
  onSlotsSelected?: (slots: TimeSlot[]) => void;
  onAllocationComplete?: (result: any) => void;
}
```

---

## 3. User Flows

### Flow 1: Auto Allocate Consultation

```
Consultant opens "Manage Timings" for 1-hour consultation
  ↓
EventTimingsCalendar loads
  ├── Fetches consultant availability
  ├── Fetches existing appointments
  └── Displays calendar with available slots (green)
  ↓
Consultant clicks "⚡ Auto Allocate"
  ↓
Loading spinner appears on button
  ↓
Backend finds first available 2 consecutive slots (e.g., Mon 10:00-11:00)
  ↓
Success: Toast appears "Timings allocated successfully"
  ↓
Dialog closes, appointments list refreshes
```

**UI States:**

1. **Initial Load:** Skeleton loader → Calendar appears
2. **Auto Allocating:** Button shows spinner, disabled
3. **Success:** Green toast, dialog closes
4. **Error:** Red toast with specific message, calendar stays open

### Flow 2: Manual Allocate Subscription

```
Consultant opens "Manage Timings" for 6-month subscription (3 calls/week)
  ↓
Dialog shows: "Schedule 3 calls/week for 6 months. Each call is 1 hour."
Footer: "📅 Select slots for 78 calls (1 hour each) | Limit: 3/week"
  ↓
Consultant clicks calendar slots
  ├── First click: Slot turns blue (selected)
  ├── Slot already booked? Tooltip: "Booked with John Doe (Consultation)"
  ├── Slot outside period? Toast: "Slot outside allowed period (Jan 1 - Jun 30)"
  └── Weekly limit reached? Toast: "Week of Jan 15 full: 3/3 calls already scheduled"
  ↓
After selecting 2 consecutive slots (1 call):
Footer updates: "✅ 1 scheduled | ⏳ 77 remaining (1 hour each) | Limit: 3/week"
  ↓
Consultant continues selecting until satisfied (not necessarily all 78)
  ↓
Clicks "✋ Allocate Manual Slots"
  ↓
Backend validates:
  ├── All slots in future? ✓
  ├── Match schedule? ✓
  ├── No conflicts? ✓
  └── Within weekly limits? ✓
  ↓
Success: Appointments created, dialog closes
```

**Real-Time Validation Feedback:**

- **Green border:** Slot is valid for selection
- **Red border:** Slot conflicts with existing appointment
- **Yellow border:** Slot is partially booked (overlapping user)
- **Gray disabled:** Slot is in the past
- **Toast messages:** Weekly limits, boundary violations

### Flow 3: Requested Times Approval

```
Consultee requests consultation at specific times (e.g., Wed 2:00-3:00 PM)
  ↓
Consultant sees request in "Requests" tab
Clicks "Use Requested Times"
  ↓
RequestedSlotsDialog opens
  ├── Shows: "Review 2 requested slots"
  └── Calls validation API
  ↓
Validation results:

  Case A: All Clear
    "✅ All Slots Available"
    "All requested slots are within your availability and have no conflicts."
    [Allocate Requested Times] button enabled

  Case B: Conflicts
    "❌ Conflicting Slots"
    "2:00 PM - Conflicts with Subscription with Jane Doe"
    "2:30 PM - Conflicts with Subscription with Jane Doe"
    [Allocate] button disabled

  Case C: Outside Availability
    "⚠️ Slots Outside Availability"
    "Wed 2:00 PM"
    "Wed 2:30 PM"
    "These slots are outside your regular availability."
    [Override and Allocate] button enabled (yellow/warning style)
  ↓
Consultant clicks "Allocate Requested Times" or "Override and Allocate"
  ↓
Success: Request approved, consultee notified
```

**UI Considerations:**

- **Conflict detection:** Real-time, shows specific appointment details
- **Override option:** Only for availability mismatch, NOT for conflicts
- **Refresh button:** Re-validate in case availability changed
- **Loading state:** Show spinner while validating

---

## 4. State Management

### useCalendarData Hook

**Purpose:** Fetch and manage calendar data (availability + appointments)

```typescript
const {
  consultantDetails, // Consultant profile data
  availableSlots, // Weekly or custom availability slots
  existingAppointments, // Already booked appointments
  loading, // Initial data loading
  error, // Fetch error
  refetch, // Manual refetch function
  getSlotStatusForInterval, // Check if specific time is available/booked
} = useCalendarData({
  consultantId,
  eventType,
  eventId,
  currentDate,
  view,
});
```

**Implementation:**

```typescript
function useCalendarData({
  consultantId,
  eventType,
  eventId,
  currentDate,
  view,
}) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      const [consultant, appointments] = await Promise.all([
        fetch(`/api/consultants/${consultantId}`),
        fetch(`/api/events/${eventType}/${eventId}/appointments`),
      ]);
      setData({ consultant, appointments });
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [consultantId, eventType, eventId]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  return { ...data, loading, error, refetch: fetchData };
}
```

### useEventSlotAllocation Hook

**Purpose:** Manage slot selection and allocation API calls

```typescript
const {
  selectedSlots, // Currently selected TimeSlot[]
  setSelectedSlots, // Setter for programmatic selection
  isAllocating, // API call in progress
  allocationError, // Allocation error message
  toggleSlot, // Add/remove slot from selection
  clearSlots, // Clear all selections
  isSlotSelected, // Check if slot is selected
  manualAllocate, // Call manual allocation API
  autoAllocate, // Call auto allocation API
  preAllocate, // Use requested times
  slotLimits, // Weekly/daily limits info
} = useEventSlotAllocation({
  eventType,
  eventId,
  consultantId,
  durationInMonths,
  durationInHours,
  callsPerWeek,
  sessionDurationInHours,
  startDate,
  endDate,
  maxTotalCalls,
  onSuccess, // Callback on successful allocation
});
```

**Key Methods:**

**toggleSlot:**

```typescript
function toggleSlot(slot: TimeSlot) {
  setSelectedSlots((prev) => {
    const exists = prev.some(
      (s) => s.startTime.getTime() === slot.startTime.getTime(),
    );
    if (exists) {
      return prev.filter(
        (s) => s.startTime.getTime() !== slot.startTime.getTime(),
      );
    } else {
      return [...prev, slot];
    }
  });
}
```

**manualAllocate:**

```typescript
async function manualAllocate() {
  setIsAllocating(true);
  try {
    const result = await AllocationAPIClient.allocate({
      eventType,
      eventId,
      mode: "manual",
      slots: selectedSlots.map((s) => s.startTime.toISOString()),
    });
    if (result.success) {
      onSuccess?.(result);
      clearSlots();
    } else {
      setAllocationError(result.error);
    }
  } finally {
    setIsAllocating(false);
  }
}
```

---

## 5. UI States & Loading

### Loading States

**Initial Load:**

```typescript
{loading ? (
  <CalendarSkeleton />
) : error ? (
  <ErrorState message={error.message} onRetry={refetch} />
) : (
  <UnifiedCalendar {...props} />
)}
```

**CalendarSkeleton Component:**

```typescript
function CalendarSkeleton() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-8 w-full" />  {/* Header */}
      <div className="grid grid-cols-7 gap-2">
        {Array.from({ length: 7 * 12 }).map((_, i) => (
          <Skeleton key={i} className="h-8 w-full" />
        ))}
      </div>
      <Skeleton className="h-12 w-full" />  {/* Footer */}
    </div>
  );
}
```

**Button Loading States:**

```typescript
<Button
  onClick={autoAllocate}
  disabled={isAllocating}
>
  {isAllocating ? (
    <>
      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
      Allocating...
    </>
  ) : (
    <>
      <Zap className="mr-2 h-4 w-4" />
      Auto Allocate
    </>
  )}
</Button>
```

### Empty States

**No Availability:**

```typescript
{availableSlots.length === 0 && (
  <div className="flex flex-col items-center justify-center h-96 text-muted-foreground">
    <Calendar className="h-12 w-12 mb-4" />
    <h3 className="font-semibold">No Availability Set</h3>
    <p className="text-sm">Configure your availability in Settings first.</p>
    <Button className="mt-4" onClick={() => router.push('/settings/availability')}>
      Go to Settings
    </Button>
  </div>
)}
```

**No Slots Selected:**

```typescript
{selectedSlots.length === 0 && mode === 'allocate' && (
  <Alert className="mt-4">
    <Info className="h-4 w-4" />
    <AlertDescription>
      Click time slots on the calendar to select them, or use Auto Allocate to let the system find available slots.
    </AlertDescription>
  </Alert>
)}
```

---

## 6. Error Handling

### Error Categories & Messages

| Error Type           | Cause                  | User Message                                          | Recovery Action            |
| -------------------- | ---------------------- | ----------------------------------------------------- | -------------------------- |
| **Network Error**    | API unreachable        | "Unable to connect. Check your internet connection."  | Retry button               |
| **Validation Error** | Business rule violated | "Week of Jan 15 full: 3/3 calls already scheduled"    | Select different week      |
| **Conflict Error**   | Double-booking         | "Slot 10:00 AM conflicts with Consultation with Jane" | Select different time      |
| **Boundary Error**   | Outside allowed period | "Slot outside allowed period (Jan 1 - Jun 30)"        | Select within range        |
| **Not Found Error**  | Invalid event ID       | "Event not found. It may have been deleted."          | Close dialog, refresh list |

### Error Display Components

**Toast Notifications (Transient Errors):**

```typescript
toast({
  variant: 'destructive',
  title: 'Allocation Failed',
  description: error.message,
  action: <ToastAction onClick={retry}>Retry</ToastAction>
});
```

**Inline Error Messages (Persistent Errors):**

```typescript
{allocationError && (
  <Alert variant="destructive">
    <AlertCircle className="h-4 w-4" />
    <AlertTitle>Allocation Failed</AlertTitle>
    <AlertDescription>{allocationError}</AlertDescription>
  </Alert>
)}
```

**Error Boundary (Component Crashes):**

```typescript
<ErrorBoundary
  fallback={<CalendarErrorFallback onReset={() => window.location.reload()} />}
>
  <UnifiedCalendar {...props} />
</ErrorBoundary>
```

### Retry Logic

**Exponential Backoff:**

```typescript
async function fetchWithRetry(fn, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (error) {
      if (i === maxRetries - 1) throw error;
      await new Promise((resolve) =>
        setTimeout(resolve, 1000 * Math.pow(2, i)),
      );
    }
  }
}
```

---

## 7. Accessibility

### Keyboard Navigation

| Key             | Action                             |
| --------------- | ---------------------------------- |
| `Tab`           | Move focus between time slots      |
| `Enter`/`Space` | Toggle slot selection              |
| `Escape`        | Close dialog / Clear selection     |
| `Arrow Keys`    | Navigate between days in week view |
| `Home`/`End`    | Jump to start/end of week          |

**Implementation:**

```typescript
<button
  role="gridcell"
  tabIndex={0}
  aria-label={`${formatTime(slot.startTime)}, ${slot.isBooked ? 'booked' : slot.isSelected ? 'selected' : 'available'}`}
  aria-pressed={slot.isSelected}
  onKeyDown={(e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggleSlot(slot);
    }
  }}
  onClick={() => toggleSlot(slot)}
>
  {formatTime(slot.startTime)}
</button>
```

### Screen Reader Announcements

**Live Regions for Dynamic Updates:**

```typescript
<div aria-live="polite" aria-atomic="true" className="sr-only">
  {selectedSlots.length} slots selected.
  {slotLimits.remaining} more slots can be selected this week.
</div>
```

**Semantic HTML:**

```typescript
<div role="grid" aria-label="Weekly calendar">
  <div role="row">
    <div role="columnheader">Sunday</div>
    <div role="columnheader">Monday</div>
    ...
  </div>
  <div role="row">
    <div role="gridcell">...</div>
  </div>
</div>
```

### Focus Management

**Trap focus in dialog:**

```typescript
<Dialog open={isOpen} onOpenChange={setIsOpen}>
  <DialogContent
    onOpenAutoFocus={(e) => {
      // Focus first slot instead of close button
      e.preventDefault();
      document.querySelector('[role="gridcell"]')?.focus();
    }}
  >
    ...
  </DialogContent>
</Dialog>
```

---

## 8. Styling Guidelines

### Color System

```typescript
// Slot states (Tailwind classes)
const slotStyles = {
  available: "bg-green-100 hover:bg-green-200 border-green-300",
  selected: "bg-primary text-primary-foreground border-primary-darker",
  booked: "bg-gray-300 cursor-not-allowed opacity-60",
  conflict: "bg-red-100 border-red-400 hover:bg-red-200",
  partial: "bg-yellow-100 border-yellow-300",
  past: "bg-gray-100 opacity-50 cursor-not-allowed",
  disabled: "bg-gray-50 cursor-not-allowed",
};
```

### Responsive Design

```css
/* Mobile (< 768px): Single-column layout */
.calendar-grid {
  grid-template-columns: 1fr;
}

/* Tablet (768px - 1024px): Compact week view */
.calendar-grid {
  grid-template-columns: repeat(7, minmax(80px, 1fr));
}

/* Desktop (> 1024px): Full month view */
.calendar-grid {
  grid-template-columns: repeat(7, minmax(120px, 1fr));
}
```

### Dark Mode Support

```typescript
<div className="bg-background text-foreground">
  {/* Uses CSS variables that adapt to theme */}
  <div className="border-border bg-card">
    <TimeSlot
      className={cn(
        'bg-green-100 dark:bg-green-900',
        'text-green-900 dark:text-green-100'
      )}
    />
  </div>
</div>
```

---

## 9. Testing Scenarios

### Manual Testing Checklist

**Consultation Allocation:**

- [ ] Auto-allocate 1-hour consultation (2 consecutive slots)
- [ ] Manually select 2 consecutive slots on same day
- [ ] Try selecting slots on different days (should error)
- [ ] Try selecting non-consecutive slots (should error)
- [ ] Select slot already booked (should show conflict tooltip)

**Subscription Allocation:**

- [ ] Auto-allocate 6-month subscription (3 calls/week)
- [ ] Manually select slots across multiple weeks
- [ ] Try selecting 4th call in week with 3/week limit (should error)
- [ ] Select slot outside subscription period (should error)
- [ ] View progress footer updates correctly

**UI States:**

- [ ] Loading skeleton appears on initial load
- [ ] Error state shows when API fails
- [ ] Empty state shows when no availability configured
- [ ] Success toast appears after allocation
- [ ] Dialog closes automatically on success

**Accessibility:**

- [ ] Tab navigation works through all slots
- [ ] Enter/Space toggles slot selection
- [ ] Screen reader announces slot state changes
- [ ] Focus trapped in dialog
- [ ] Escape key closes dialog

### Unit Test Examples

```typescript
describe('UnifiedCalendar', () => {
  it('should display available slots in green', () => {
    render(<UnifiedCalendar {...props} />);
    const availableSlots = screen.getAllByRole('gridcell', { name: /available/i });
    expect(availableSlots[0]).toHaveClass('bg-green-100');
  });

  it('should toggle slot selection on click', () => {
    render(<UnifiedCalendar {...props} />);
    const slot = screen.getByRole('gridcell', { name: /10:00 AM/i });
    fireEvent.click(slot);
    expect(slot).toHaveClass('bg-primary');
  });

  it('should show error toast when weekly limit exceeded', async () => {
    // Mock API to return weekly limit error
    render(<UnifiedCalendar {...props} />);
    // Select 4 slots in same week (limit is 3)
    // ... click slots ...
    await waitFor(() => {
      expect(screen.getByText(/weekly limit reached/i)).toBeInTheDocument();
    });
  });
});
```

---

## 10. Troubleshooting

### Common Issues

**Issue: Slots appear booked but shouldn't be**

```
Cause: Stale data in calendar
Fix: Call refetch() after allocation
Check: Ensure useEffect dependency array includes currentDate
```

**Issue: Weekly limit not enforced correctly**

```
Cause: Week counting algorithm mismatch
Fix: Use SlotCalculationService.countWeeks() consistently
Check: Verify startDate/endDate are set correctly
```

**Issue: Timezone conversion incorrect**

```
Cause: Mixing local and UTC dates
Fix: Always store UTC in DB, convert to local only for display
Check: Use date-fns-tz for timezone conversions
```

**Issue: Calendar performance slow with many appointments**

```
Cause: Re-rendering entire grid on every state change
Fix: Memoize weekDates, useMemo for slot status calculations
Check: Use React DevTools Profiler to identify bottlenecks
```

**Issue: Dialog doesn't close after successful allocation**

```
Cause: onAllocationComplete callback not called
Fix: Ensure SlotAllocationService calls onSuccess callback
Check: Verify onClose is wired to dialog's onOpenChange
```

### Debug Tools

**Console Logging (Development Only):**

```typescript
// EventTimingsCalendar.tsx (lines 150-209)
// Already includes debug logs for subscription/class validation
// Remove these in production builds
console.log("[Subscription Validation Period]", {
  subscriptionId,
  startDate,
  endDate,
  maxTotalCalls,
});
```

**React DevTools:**

- **Components Tab:** Inspect prop drilling and state updates
- **Profiler Tab:** Identify re-render performance issues

**Network Tab:**

- Check `/api/events/{type}/{id}/allocate` request/response
- Verify slot format: `["2025-01-15T10:00:00.000Z", ...]`

---

## Quick Reference

### Event Type Cheat Sheet

| Event Type   | Duration Prop            | Same-Day Required       | Weekly Limits | Creates Multiple Appointments |
| ------------ | ------------------------ | ----------------------- | ------------- | ----------------------------- |
| Consultation | `durationInHours`        | ✅ Yes                  | ❌ No         | ❌ No (1 appointment)         |
| Subscription | `sessionDurationInHours` | ❌ No                   | ✅ Yes        | ✅ Yes (1 per call)           |
| Webinar      | `durationInHours`        | ❌ No                   | ❌ No         | ❌ No (1 appointment)         |
| Class        | `sessionDurationInHours` | ❌ No (but per session) | ✅ Yes        | ✅ Yes (1 per session)        |

### API Endpoints Quick Reference

```typescript
// Allocation
POST /api/events/consultations/[id]/allocate { isAuto, slots?, useRequestedSlots? }
POST /api/events/subscriptions/[id]/allocate { ... }
POST /api/events/classes/[id]/allocate { ... }
POST /api/events/webinars/[id]/allocate { ... }

// Validation
POST /api/events/consultations/[id]/validate { slots: string[] }
POST /api/events/subscriptions/[id]/validate { slots: string[] }
// ... same for classes/webinars
```

---

## Conclusion

This guide provides comprehensive coverage of the booking UI implementation. Key takeaways:

✅ **Component Reusability:** UnifiedCalendar handles all 4 event types
✅ **Clear User Feedback:** Loading states, error messages, progress tracking
✅ **Accessibility First:** Keyboard navigation, screen readers, focus management
✅ **Performance Optimized:** Memoization, debouncing, efficient re-renders
✅ **Production Ready:** Error boundaries, retry logic, comprehensive testing

For backend architecture details, see [ARCHITECTURE.md](./ARCHITECTURE.md).
