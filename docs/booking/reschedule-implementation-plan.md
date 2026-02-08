# Reschedule System Implementation Plan

**Created:** 2026-02-07
**Status:** Ready for Implementation
**Architectural Decision:** DELETE appointments (not FLAG)

---

## Executive Summary

This plan addresses all 5 validated issues in the reschedule flow by implementing a phased approach:
1. Quick wins (no breaking changes)
2. Schema enhancements
3. API migration to session-based architecture
4. Frontend updates
5. Comprehensive testing

**Total Estimated Time:** 22-36 hours across 5 phases

---

## Phase 1: Quick Wins (2-4 hours) 🟢 SAFE

### Task #6: Fix Status Preservation (Issue #2)
**Priority:** HIGH | **File:** `route.ts` | **Breaking:** No

**Problem:** Subscription always set to PENDING, even for 1-session reschedule

**Solution:**
```typescript
// route.ts:200-204
const isEntireReschedule = !slotIds || slotIds.length === 0;
await tx.subscription.update({
  where: { id: appointment.subscription.id },
  data: {
    requestStatus: isEntireReschedule ? "PENDING" : "APPROVED"
  },
});
```

**Testing:**
- 1 session reschedule → APPROVED ✓
- 5 sessions reschedule → APPROVED ✓
- Entire reschedule → PENDING ✓

---

### Task #7: Return Session Count (Issue #5)
**Priority:** HIGH | **Files:** `route.ts`, `EventCard.tsx` | **Breaking:** No

**Problem:** Toast shows "72 sessions" instead of "18 sessions"

**Solution:**
```typescript
// route.ts:235-243
const sessionDuration = appointment.subscription.subscriptionPlan.sessionDurationInHours;
const slotsPerSession = Math.ceil(sessionDuration / 0.5);

return {
  success: true,
  rescheduleType,
  slotsAffected: slotsToReschedule.length,
  sessionsAffected: Math.ceil(slotsToReschedule.length / slotsPerSession), // ADD
  message: ...
};
```

```typescript
// EventCard.tsx:270-271
const sessionsAffected = data.sessionsAffected ?? /* fallback */;
toast({ description: `Select new times for your ${sessionsAffected} sessions.` });
```

**Testing:**
- 72 slots (18 sessions) → "18 sessions" ✓

---

## Phase 2: Schema Updates (4-6 hours) 🟡 MIGRATION REQUIRED

### Task #8: Add sessionsAwaitingReschedule Field (Issue #3)
**Priority:** MEDIUM | **File:** `schema.prisma` | **Breaking:** Migration

**Problem:** No tracking for partial reschedules

**Solution:**
```prisma
model Subscription {
  id                          String   @id @default(cuid())
  requestStatus               RequestStatus @default(PENDING)
  sessionsAwaitingReschedule  Int      @default(0) // ADD
  ...
}
```

**Migration:**
```bash
npx prisma migrate dev --name add_sessions_awaiting_reschedule
```

---

### Task #9: Maintain Counter in API
**Priority:** MEDIUM | **File:** `route.ts` | **Breaking:** No

**Solution:**
```typescript
// Increment on reschedule
const sessionsBeingRescheduled = Math.ceil(slotsToReschedule.length / slotsPerSession);
await tx.subscription.update({
  data: {
    sessionsAwaitingReschedule: { increment: sessionsBeingRescheduled }
  }
});
```

**Also update:** `SlotAllocationService.ts` to DECREMENT on allocation

---

### Task #10: Update Consultant Queries
**Priority:** MEDIUM | **File:** Consultant requests tab | **Breaking:** No

**Solution:**
```typescript
where: {
  OR: [
    { requestStatus: "PENDING" },
    { sessionsAwaitingReschedule: { gt: 0 } }
  ]
}
```

---

## Phase 3: API Migration (8-12 hours) 🔴 BREAKING CHANGE

### Task #11: Migrate to appointmentIds (Issue #1)
**Priority:** HIGH | **Breaking:** YES

**New API Contract:**
```typescript
// OLD: POST /api/appointments/{appointmentId}/reschedule?type=SUBSCRIPTION
// NEW: POST /api/subscriptions/{subscriptionId}/reschedule

Body: {
  "appointmentIds": ["appt1", "appt2"],
  "rescheduleType": "partial" | "entire"
}

Response: {
  "success": true,
  "sessionsRescheduled": 3,
  "sessionsSkipped": 0,
  "slotsReleased": 12
}
```

**Benefits:**
- Session-level abstraction
- Cleaner API contract
- Aligns with appointment = session model

---

### Task #12: Implement DELETE Logic
**Priority:** HIGH | **Breaking:** YES

**Solution:**
```typescript
// DELETE appointments instead of flagging
await tx.appointment.deleteMany({
  where: { id: { in: appointmentIdsToReschedule } }
});
// SlotOfAppointment cascade deletes automatically
```

**Benefits:**
- Slots immediately available
- No tentative management
- Cleaner database

---

### Task #13: Filter Completed Sessions
**Priority:** MEDIUM | **Breaking:** No

**Solution:**
```typescript
const now = new Date();
const upcomingAppointments = rescheduleType === "entire"
  ? allAppointments.filter(apt => new Date(apt.slotsOfAppointment[0].startsAt) > now)
  : allAppointments;
```

**Example:** 18 sessions (4 completed) → only 14 deleted

---

## Phase 4: Frontend Updates (4-6 hours) 🔴 BREAKING CHANGE

### Task #14: Send appointmentIds
**Priority:** HIGH | **File:** `EventCard.tsx` | **Breaking:** YES

**Solution:**
```typescript
// OLD:
const sessionSlotIds = session.slots.map(s => s.id);
body: { slotIds: sessionSlotIds }

// NEW:
const sessionAppointmentId = session.appointmentId;
body: { appointmentIds: [sessionAppointmentId], rescheduleType }
```

---

### Task #15: Add appointmentId to Session Objects
**Priority:** HIGH | **File:** `EventCard.tsx` | **Breaking:** No

**Solution:**
```typescript
const groupedSessions = React.useMemo(() => ({
  appointmentId: currentSessionSlots[0].appointmentId, // ADD
  slots: [...slots],
  ...
}), [rawSlots]);
```

---

## Phase 5: Testing (4-8 hours)

### Task #16: Comprehensive Testing

**Test Cases:**
1. ✅ Single session reschedule
2. ✅ Multiple sessions reschedule
3. ✅ Entire subscription reschedule
4. ✅ 24-hour restriction
5. ✅ Consultant visibility
6. ✅ Completed sessions filtering
7. ✅ Slot availability after delete
8. ✅ Counter increment/decrement
9. ✅ Toast message accuracy
10. ✅ Edge cases (race conditions, etc.)

---

## Deployment Strategy

### Option 1: Phased Rollout (Recommended)
1. **Week 1:** Deploy Phase 1 (Quick Wins)
   - Zero risk, immediate UX improvement
2. **Week 2:** Deploy Phase 2 (Schema Updates)
   - Requires migration, low risk
3. **Week 3-4:** Deploy Phase 3 + 4 together (API + Frontend)
   - Breaking changes, requires coordination
   - Deploy during low-traffic window
4. **Week 5:** Phase 5 (Testing in Production)

### Option 2: Big Bang
- Implement all phases
- Test in staging
- Deploy all at once
- Higher risk, faster completion

---

## Rollback Plan

**Phase 1 & 2:** Safe to rollback via database migration

**Phase 3 & 4:** Requires coordinated rollback:
1. Revert frontend to send slotIds
2. Revert backend to old route
3. Re-enable isTentative logic

**Database:** No data loss (deletes only happen after user confirmation)

---

## Success Metrics

- ✅ Partial reschedule keeps APPROVED status
- ✅ Toast shows session count, not slot count
- ✅ Consultant can see subscriptions with partial reschedules
- ✅ Deleted slots available for rebooking
- ✅ No regression in existing functionality
- ✅ All 11 tasks completed and tested

---

## Next Steps

1. Review and approve this plan
2. Start with Phase 1 (safe, immediate value)
3. Schedule migration window for Phase 2
4. Coordinate deployment for Phase 3 + 4
5. Run comprehensive tests (Phase 5)

**Ready to begin? Start with Task #6!** 🚀
