# Reschedule Flow - Issue Validation Report

**Date:** 2026-02-07
**Validated By:** Claude Code Analysis
**Document:** Reschedule Flow Analysis and Implementation Plan

## Executive Summary

All 5 issues identified in the reschedule flow analysis have been **confirmed as legitimate** through code examination. The issues range from architectural concerns to UX problems.

---

## Issue-by-Issue Validation

### ✅ Issue #1: slotIds vs Session-based Selection
**Status:** LEGITIMATE ISSUE
**Priority:** HIGH
**Category:** Architecture

**Evidence:**
- **File:** `EventCard.tsx:860-872`
- Frontend collects individual slot IDs: `session.slots.map((s) => s.id)`
- API receives array of slot IDs, not session/appointment IDs
- Example: 2-hour session sends `["slot1", "slot2", "slot3", "slot4"]`

**Problem:**
- No session-level abstraction in API contract
- Relationship between slots maintained only by frontend grouping
- If UI changes, slot grouping could break

**Recommendation:** Accept `appointmentIds[]` instead of `slotIds[]`

---

### ✅ Issue #2: Status Always Sets to PENDING
**Status:** LEGITIMATE ISSUE
**Priority:** HIGH
**Category:** Business Logic

**Evidence:**
- **File:** `route.ts:200-204`
```typescript
await tx.subscription.update({
  where: { id: appointment.subscription.id },
  data: { requestStatus: "PENDING" },  // ⚠️ Unconditional
});
```

**Problem:**
- Subscription set to PENDING for ALL reschedule cases:
  - 1 session out of 18 → PENDING
  - 5 sessions out of 18 → PENDING
  - All 18 sessions → PENDING
- User may be blocked from joining confirmed sessions
- Consultant sees entire subscription as "pending"

**Recommendation:** Only set PENDING for entire subscription reschedule

---

### ✅ Issue #3: No Indication of Partial Reschedule
**Status:** LEGITIMATE ISSUE
**Priority:** MEDIUM
**Category:** Data Model

**Evidence:**
- **File:** `schema.prisma:812-842`
- Subscription model has NO tracking fields:
  - ❌ `sessionsAwaitingReschedule`
  - ❌ `partialRescheduleInProgress`
  - ❌ `tentativeSessionCount`

**Problem:**
- Only `isTentative` flag on individual slots
- Consultant must query all appointments and count tentative slots manually
- No visibility into which/how many sessions need rescheduling

**Recommendation:** Add `sessionsAwaitingReschedule: Int` field to Subscription model

---

### ✅ Issue #4: 24-Hour Validation on Individual Slots
**Status:** CONFIRMED (Low Priority)
**Priority:** LOW
**Category:** Validation Logic

**Evidence:**
- **File:** `route.ts:139-152`
```typescript
for (const slot of slotsToReschedule) {
  const hoursUntilSlot = (new Date(slot.startsAt).getTime() - now.getTime()) / (1000 * 60 * 60);
  if (hoursUntilSlot < MINIMUM_HOURS_BEFORE_RESCHEDULE) {
    throw new ReschedulePolicyError(...);
  }
}
```

**Problem:**
- Each 30-min slot validated independently
- Edge case: Session spanning midnight could have inconsistent checks
- Not session-aware

**Verdict:**
- Works correctly but could be more intuitive
- Suggestion to check session start time is an optimization, not critical

**Recommendation:** Low priority - current logic is safe but not optimal

---

### ✅ Issue #5: Toast Shows Slot Count, Not Session Count
**Status:** LEGITIMATE ISSUE
**Priority:** HIGH
**Category:** UX

**Evidence:**
- **File:** `EventCard.tsx:270-279`
```typescript
const slotsAffected = data.slotsAffected ?? slotIds?.length ?? rawSlots.length;
toast({
  description: `Select new times for your ${slotsAffected} sessions.`,
});
```
- **File:** `route.ts:238`
```typescript
slotsAffected: slotsToReschedule.length,  // Returns SLOT count, not session count
```

**Problem:**
- 18 sessions × 4 slots = 72 slots
- Toast shows: "Select new times for your **72 sessions**" ❌
- Should show: "Select new times for your **18 sessions**" ✅

**Recommendation:** Backend should return session count, not slot count

---

## Priority Classification

| Priority | Issues | Impact |
|----------|--------|--------|
| **HIGH** | #1, #2, #5 | Affects core functionality, UX, and data integrity |
| **MEDIUM** | #3 | Affects consultant visibility and workflow |
| **LOW** | #4 | Edge case, current logic works correctly |

---

## Recommended Implementation Order

1. **Phase 1 (Critical):**
   - Fix Issue #2: Preserve APPROVED status for partial reschedules
   - Fix Issue #5: Return session count in API response

2. **Phase 2 (Architecture):**
   - Fix Issue #1: Migrate to appointment-based API (breaking change)
   - Fix Issue #3: Add session tracking fields to schema

3. **Phase 3 (Optimization):**
   - Fix Issue #4: Session-based 24-hour validation

---

## Conclusion

All 5 issues are **legitimate concerns** that should be addressed. Issues #1, #2, and #5 are high priority and impact user experience significantly. The implementation plan proposed in the analysis document is sound and should be followed.

**Next Steps:**
1. Review and approve implementation plan
2. Create implementation tasks for each phase
3. Begin with Phase 1 (critical fixes)
