Ready to code?

Here is Claude’s plan:

Comprehensive UI Testing Plan - Booking Allocation System

Testing Approach: Chrome DevTools MCP + Real Database

I’ll conduct mass-scale, systematic UI testing of the Requests and Appointments tabs, covering edge cases, corner cases, impossible scenarios, and large-scale operations.

⸻

PHASE 1: REQUESTS TAB - Auto-Allocation Testing

1A. Standard Cases (Baseline Verification)
• 1-hour consultation (2 slots) with WEEKLY schedule consultant
• 2-hour consultation (4 slots) with CUSTOM schedule consultant
• 1-month subscription (4 slots, 1 call/week)
• Verify: Success messages, status changes to APPROVED, database updates

1B. Edge Cases - Large Allocations
• 4-hour consultation (8 consecutive slots required) - Most will FAIL due to insufficient consecutive availability
• 6-month subscription (48 slots, 2 calls/week) - Sparse availability test
• 12-month subscription (144+ slots, 3 calls/week) - STRESS TEST for algorithm performance

1C. Impossible Cases (Expected Failures)
• Auto-allocate with zero available slots in consultant’s schedule
• Auto-allocate 4-hour consultation when consultant only has 1-hour blocks scattered
• Subscription with date range BEFORE consultant’s availability starts
• Request exceeding consultant’s total availability

1D. Boundary Testing
• First available slot (earliest date)
• Last available slot before scheduling period ends
• Allocation spanning month boundaries
• Weekend-only availability vs weekday-only requests

⸻

PHASE 2: REQUESTS TAB - Manual Allocation Testing

2A. Valid Manual Selections
• Select exact consecutive slots for 2-hour consultation
• Select distributed slots for subscription (different weeks)
• Select from sparse availability (only few slots available)

2B. Invalid Manual Selections (Should Fail with Clear Errors)
• Select non-consecutive slots for consultation
• Select slots outside availability (should be disabled in calendar)
• Select past dates (should be disabled)
• Select already booked slots (should show as unavailable)
• Select wrong number of slots (less or more than required)

2C. Edge Cases
• Select slots at midnight boundary
• Select maximum allowed slots for large subscription
• Switch between manual and auto modes
• Calendar navigation across multiple months

⸻

PHASE 3: APPOINTMENTS TAB - View & Management

3A. List View Testing
• View all appointments (pagination with 10+ items)
• Filter by: Consultations, Subscriptions, Webinars, Classes
• Sort by date/time
• Search functionality

3B. Appointment Details
• Open consultation appointment (verify 2-4 slots displayed)
• Open subscription appointment (verify 48+ slots displayed correctly)
• View participant information
• Check timezone display accuracy

3C. Appointment Modifications
• Reschedule single appointment slot
• Cancel upcoming appointment
• Verify conflict detection on reschedule

⸻

PHASE 4: Corner Cases & Stress Tests

4A. Schedule Type Variations
• Test consultant with WEEKLY schedule (recurring pattern)
• Test consultant with CUSTOM schedule (one-time slots)
• Test consultant with mixed availability (some weeks full, some empty)

4B. Conflict Scenarios
• Attempt to allocate slot already booked by another request
• Double-booking prevention
• Partial overlap detection

4C. Data Volume Tests
• Consultant with 48 custom slots (Mindy Armstrong)
• Allocation requiring 144+ slots (12-month comprehensive subscription)
• Calendar rendering with dense availability (all days, all hours)
• Pagination with 50+ appointments

4D. UI Robustness
• Rapid calendar navigation (stress test React rendering)
• Multiple slot selections/deselections
• Error recovery (failed allocation → retry)
• Network timeout simulation

⸻

PHASE 5: Cross-Browser & Accessibility

5A. Visual Verification
• Calendar slot colors (available=green, unavailable=gray, selected=blue, booked=red)
• Dialog/modal rendering
• Mobile responsiveness
• Loading spinner behavior

5B. Error Message Quality
• Clear, actionable error messages
• No technical jargon in user-facing errors
• Suggested remediation steps

⸻

Test Execution Strategy

For Each Test: 1. Navigate to Requests/Appointments tab 2. Take snapshot to verify UI state 3. Interact with UI elements (click auto-allocate, select slots, etc.) 4. Take screenshot of results 5. Verify via API/database that backend matches UI state 6. Document any discrepancies

Success Criteria:
• ✅ All standard cases work correctly
• ✅ Edge cases either succeed OR fail with clear error messages
• ✅ Impossible cases fail gracefully with helpful messages
• ✅ No crashes, blank screens, or console errors
• ✅ UI state matches database state
• ✅ Performance acceptable even with 144+ slot allocations

Test Consultants:
• Christina.Thompson91@yahoo.com (WEEKLY, 22 slots) - Already tested
• Yolanda63@yahoo.com (WEEKLY, 20 slots)
• Trinity.Ondricka@hotmail.com (CUSTOM, 24 slots)
• Shad.Lockman38@yahoo.com (CUSTOM, 48 slots)

Would you like me to proceed with this comprehensive testing plan?

Would you like to proceed?

❯ 1. Yes, and auto-accept edits 2. Yes, and manually approve edits 3. No, keep planning
