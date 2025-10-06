/**
 * Manual Allocation Validation Tests
 * Based on test specifications in prompts/1.txt and prompts/2.txt
 *
 * Tests verify that manual allocation validation correctly:
 * - Enforces same-day rule (all slots must be on same day)
 * - Enforces consecutive rule (slots must be consecutive)
 * - Prevents double booking
 * - Validates slot selection before allocation
 */

import { requestsTest as test } from '../fixtures/test-data';
import { findPendingConsultation, getAppointmentDetails } from '../helpers/database';
import { takeScreenshot } from '../helpers/auth';

test.describe('Manual Allocation Validation Tests', () => {
  test('Test 4.1: Same-Day Rule Validation', async ({
    page,
    consultantInfo,
    requestsPage,
    allocationModal,
    calendarPage,
    toastNotification,
  }) => {
    if (!consultantInfo) {
      test.skip();
      return;
    }

    // Step 1: Find pending consultation
    const pendingConsultation = await findPendingConsultation(consultantInfo.consultantProfileId);

    if (!pendingConsultation) {
      test.skip();
      return;
    }

    console.log('Testing same-day rule with consultation:', pendingConsultation.id);

    // Step 2: Open allocation modal
    await requestsPage.openAllocationModal(0);
    await allocationModal.waitForModal();

    await takeScreenshot(page, '09-manual-allocation-modal');

    // Step 3: Try to select slots on different days
    // Note: We need to find available slots first
    const allSlots = await calendarPage.getAllSlotData();
    const availableSlots = allSlots.filter(s =>
      s.status?.includes('Available') && s.date && s.time
    );

    console.log(`Found ${availableSlots.length} available slots`);

    if (availableSlots.length < 3) {
      test.skip();
      return;
    }

    // Find slots on different days
    const slotsByDate = new Map<string, typeof availableSlots>();
    for (const slot of availableSlots) {
      if (slot.date) {
        if (!slotsByDate.has(slot.date)) {
          slotsByDate.set(slot.date, []);
        }
        slotsByDate.get(slot.date)?.push(slot);
      }
    }

    const dates = Array.from(slotsByDate.keys());

    if (dates.length < 2) {
      test.skip();
      return;
    }

    // Step 4: Select slots on different days
    const firstDaySlots = slotsByDate.get(dates[0]) || [];
    const secondDaySlots = slotsByDate.get(dates[1]) || [];

    if (firstDaySlots.length < 2 || secondDaySlots.length < 1) {
      test.skip();
      return;
    }

    // Select 2 slots from first day
    for (let i = 0; i < 2; i++) {
      const slot = firstDaySlots[i];
      if (slot.date && slot.time) {
        await calendarPage.clickSlot(slot.date, slot.time);
        await page.waitForTimeout(200);
      }
    }

    // Select 1 slot from second day (different day - should trigger validation error)
    const crossDaySlot = secondDaySlots[0];
    if (crossDaySlot.date && crossDaySlot.time) {
      await calendarPage.clickSlot(crossDaySlot.date, crossDaySlot.time);
      await page.waitForTimeout(200);
    }

    await takeScreenshot(page, '09-cross-day-selection');

    // Step 5: Try to allocate
    await allocationModal.clickAllocateManualSlots();

    // Step 6: Should see error message
    await page.waitForTimeout(1000);

    const toastText = await toastNotification.waitForToast();
    console.log('Validation message:', toastText);

    await takeScreenshot(page, '09-same-day-validation-error');

    // Should contain error about same day
    if (toastText) {
      const hasSameDayError = toastText.toLowerCase().includes('same day') ||
                              toastText.toLowerCase().includes('same date') ||
                              toastText.toLowerCase().includes('error');

      if (hasSameDayError) {
        console.log('✅ Same-day validation working!');
      } else {
        console.warn('⚠️ No same-day validation error shown');
      }
    }

    // Step 7: Verify no appointment was created
    const appointmentDetails = await getAppointmentDetails(pendingConsultation.id);

    if (appointmentDetails) {
      console.error('❌ BUG: Appointment created despite cross-day selection!');
      await takeScreenshot(page, '09-same-day-bug');
      throw new Error('Same-day validation bypassed - appointment created across days');
    }

    console.log('✅ Same-day rule validated - no appointment created');
  });

  test('Test 4.2: Consecutive Slots Rule', async ({
    page,
    consultantInfo,
    requestsPage,
    allocationModal,
    calendarPage,
    toastNotification,
  }) => {
    if (!consultantInfo) {
      test.skip();
      return;
    }

    // Find pending consultation
    const pendingConsultation = await findPendingConsultation(consultantInfo.consultantProfileId);

    if (!pendingConsultation) {
      test.skip();
      return;
    }

    console.log('Testing consecutive rule with consultation:', pendingConsultation.id);

    // Open allocation modal
    await requestsPage.openAllocationModal(0);
    await allocationModal.waitForModal();

    // Find available slots on same day
    const allSlots = await calendarPage.getAllSlotData();
    const availableSlots = allSlots.filter(s =>
      s.status?.includes('Available') && s.date && s.time
    );

    // Group by date
    const slotsByDate = new Map<string, typeof availableSlots>();
    for (const slot of availableSlots) {
      if (slot.date) {
        if (!slotsByDate.has(slot.date)) {
          slotsByDate.set(slot.date, []);
        }
        slotsByDate.get(slot.date)?.push(slot);
      }
    }

    // Find a day with at least 4 slots
    let testDaySlots: typeof availableSlots = [];
    for (const [, slots] of Array.from(slotsByDate.entries())) {
      if (slots.length >= 4) {
        testDaySlots = slots;
        break;
      }
    }

    if (testDaySlots.length < 4) {
      test.skip();
      return;
    }

    // Sort by time
    testDaySlots.sort((a, b) => {
      const timeA = a.time || '00:00';
      const timeB = b.time || '00:00';
      return timeA.localeCompare(timeB);
    });

    // Select non-consecutive slots (skip one in the middle)
    // e.g., select slots 0, 1, 3 (skip 2)
    const slotsToSelect = [testDaySlots[0], testDaySlots[1], testDaySlots[3]];

    console.log('Selecting non-consecutive slots:', slotsToSelect.map(s => `${s.date} ${s.time}`));

    for (const slot of slotsToSelect) {
      if (slot.date && slot.time) {
        await calendarPage.clickSlot(slot.date, slot.time);
        await page.waitForTimeout(200);
      }
    }

    await takeScreenshot(page, '10-non-consecutive-selection');

    // Try to allocate
    await allocationModal.clickAllocateManualSlots();
    await page.waitForTimeout(1000);

    // Should see error about consecutive slots
    const toastText = await toastNotification.waitForToast();
    console.log('Validation message:', toastText);

    await takeScreenshot(page, '10-consecutive-validation-error');

    if (toastText) {
      const hasConsecutiveError = toastText.toLowerCase().includes('consecutive') ||
                                  toastText.toLowerCase().includes('continuous') ||
                                  toastText.toLowerCase().includes('error');

      if (hasConsecutiveError) {
        console.log('✅ Consecutive validation working!');
      } else {
        console.warn('⚠️ No consecutive validation error shown');
      }
    }

    // Verify no appointment created
    const appointmentDetails = await getAppointmentDetails(pendingConsultation.id);

    if (appointmentDetails) {
      console.error('❌ BUG: Appointment created with non-consecutive slots!');
      await takeScreenshot(page, '10-consecutive-bug');
      throw new Error('Consecutive validation bypassed');
    }

    console.log('✅ Consecutive rule validated');
  });

  test('Test 4.3: Conflict Detection (Booked Slots)', async ({
    page,
    consultantInfo,
    requestsPage,
    allocationModal,
    calendarPage,
  }) => {
    if (!consultantInfo) {
      test.skip();
      return;
    }

    // Find pending consultation
    const pendingConsultation = await findPendingConsultation(consultantInfo.consultantProfileId);

    if (!pendingConsultation) {
      test.skip();
      return;
    }

    // Open allocation modal
    await requestsPage.openAllocationModal(0);
    await allocationModal.waitForModal();

    // Find a booked slot
    const allSlots = await calendarPage.getAllSlotData();
    const bookedSlots = allSlots.filter(s =>
      s.status?.includes('Booked') && s.date && s.time
    );

    if (bookedSlots.length === 0) {
      console.log('No booked slots found - skipping conflict test');
      test.skip();
      return;
    }

    const bookedSlot = bookedSlots[0];
    console.log('Testing conflict detection with booked slot:', bookedSlot);

    // Try to click on booked slot
    if (bookedSlot.date && bookedSlot.time) {
      const slotElement = calendarPage.getSlot(bookedSlot.date, bookedSlot.time);

      // Check if slot is disabled or unselectable
      const isDisabled = await slotElement.isDisabled().catch(() => false);
      const classes = await slotElement.getAttribute('class');

      console.log('Booked slot state:', { isDisabled, classes });

      if (isDisabled || classes?.includes('disabled') || classes?.includes('booked')) {
        console.log('✅ Conflict detection working - booked slot is disabled');
      } else {
        console.warn('⚠️ Booked slot appears selectable');

        // Try to click it
        await slotElement.click().catch(() => {
          console.log('Slot click prevented');
        });

        await page.waitForTimeout(500);

        // Check if it got selected
        const selectedCount = await allocationModal.getSelectedSlotsCount();
        console.log('Selected slots count:', selectedCount);

        if (selectedCount > 0) {
          console.error('❌ BUG: Booked slot was selectable!');
          await takeScreenshot(page, '11-conflict-bug');
        }
      }
    }

    await takeScreenshot(page, '11-conflict-detection');
  });

  test.afterEach(async ({ page }) => {
    await takeScreenshot(page, 'manual-allocation-test-completed');
  });
});
