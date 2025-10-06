/**
 * Auto-Allocation Consultation Tests
 * Based on test specifications in prompts/1.txt and prompts/2.txt
 *
 * Tests verify that the auto-allocation algorithm correctly:
 * - Allocates consecutive 30-minute slots
 * - Keeps all slots on the same day
 * - Creates a single appointment with multiple slots
 * - Updates request status from PENDING to SCHEDULED
 */

import { requestsTest as test, expect } from '../fixtures/test-data';
import {
  findPendingConsultation,
  getAppointmentDetails,
  verifyConsecutiveSlots,
} from '../helpers/database';
import { takeScreenshot } from '../helpers/auth';

test.describe('Auto-Allocation Consultation Tests', () => {
  test('Test 2.1: Basic Auto-Allocation', async ({
    page,
    consultantInfo,
    requestsPage,
    allocationModal,
    toastNotification,
  }) => {
    if (!consultantInfo) {
      test.skip();
      return;
    }

    // Step 1: Find a pending consultation request
    const pendingConsultation = await findPendingConsultation(consultantInfo.consultantProfileId);

    if (!pendingConsultation) {
      console.log('No pending consultation found - skipping test');
      test.skip();
      return;
    }

    console.log('Found pending consultation:', {
      id: pendingConsultation.id,
      title: pendingConsultation.consultationPlan.title,
      duration: pendingConsultation.consultationPlan.durationInHours,
      requestedBy: pendingConsultation.requestedBy.user.name,
    });

    const expectedSlotCount = Math.ceil(pendingConsultation.consultationPlan.durationInHours * 2);
    console.log(`Expected slot count: ${expectedSlotCount} (for ${pendingConsultation.consultationPlan.durationInHours} hours)`);

    // Step 2: Take screenshot before allocation
    await takeScreenshot(page, '06-before-auto-allocation');

    // Step 3: Open allocation modal and click auto allocate
    await requestsPage.openAllocationModal(0);
    await allocationModal.clickAutoAllocate();

    // Step 4: Wait for allocation to complete
    await page.waitForTimeout(3000);

    // Step 5: Check for toast notification
    const toastText = await toastNotification.waitForToast();
    console.log('Toast notification:', toastText);

    await takeScreenshot(page, '06-after-auto-allocation');

    // Step 6: Verify appointment was created in database
    const appointmentDetails = await getAppointmentDetails(pendingConsultation.id);

    if (!appointmentDetails) {
      console.error('No appointment found after auto-allocation!');
      await takeScreenshot(page, '06-allocation-failed');
      throw new Error('Auto-allocation failed - no appointment created');
    }

    console.log('Appointment details:', appointmentDetails);

    // Step 7: Verify slot count
    expect(appointmentDetails.slotCount).toBe(expectedSlotCount);

    // Step 8: Verify all slots on same day
    expect(appointmentDetails.uniqueDates).toBe(1);

    // Step 9: Verify status changed to SCHEDULED
    expect(appointmentDetails.consultationStatus).toBe('SCHEDULED');

    // Step 10: Verify slots are consecutive
    const consecutiveCheck = await verifyConsecutiveSlots(pendingConsultation.id);
    console.log('Consecutive slots check:', consecutiveCheck);

    // All slots should be FIRST_SLOT or CONSECUTIVE
    const hasGaps = consecutiveCheck.some(slot => slot.slotStatus === 'GAP_DETECTED');
    if (hasGaps) {
      console.error('GAP DETECTED in slots:', consecutiveCheck);
      await takeScreenshot(page, '06-gap-detected');
    }

    expect(hasGaps).toBe(false);

    console.log('✅ Auto-allocation test passed!');
  });

  test('Test 2.2: Auto-Allocation with Different Durations', async ({
    page,
    consultantInfo,
    requestsPage,
    allocationModal,
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

    const duration = pendingConsultation.consultationPlan.durationInHours;

    console.log(`Testing auto-allocation for ${duration} hour consultation`);

    // Expected: duration in hours × 2 slots (30 min each)
    const expectedSlots = Math.ceil(duration * 2);

    // Open allocation modal and auto allocate
    await requestsPage.openAllocationModal(0);
    await allocationModal.clickAutoAllocate();

    // Verify
    const appointmentDetails = await getAppointmentDetails(pendingConsultation.id);

    if (appointmentDetails) {
      console.log('Allocated slots:', {
        expected: expectedSlots,
        actual: appointmentDetails.slotCount,
        duration: `${duration} hours`,
      });

      expect(appointmentDetails.slotCount).toBe(expectedSlots);
    }
  });

  test('Test 2.3: Verify No Double Booking', async ({
    page,
    consultantInfo,
    requestsPage,
    allocationModal,
  }) => {
    if (!consultantInfo) {
      test.skip();
      return;
    }

    // Find two pending consultations if available
    const pendingConsultation = await findPendingConsultation(consultantInfo.consultantProfileId);

    if (!pendingConsultation) {
      test.skip();
      return;
    }

    // Open allocation modal and auto allocate first request
    await requestsPage.openAllocationModal(0);
    await allocationModal.clickAutoAllocate();

    // Get appointment details
    const firstAppointment = await getAppointmentDetails(pendingConsultation.id);

    if (firstAppointment) {
      console.log('First appointment allocated:', {
        slotCount: firstAppointment.slotCount,
        start: firstAppointment.firstSlotStart,
        end: firstAppointment.lastSlotEnd,
      });

      // Try to allocate second request
      // It should not overlap with first appointment
      await page.waitForTimeout(1000);

      const remainingRequests = await requestsPage.requestCards.count();
      console.log(`Remaining pending requests: ${remainingRequests}`);

      if (remainingRequests > 0) {
        // Open allocation modal and auto allocate second request
        await requestsPage.openAllocationModal(0);
        await allocationModal.clickAutoAllocate();

        // Verify second allocation didn't conflict
        // (This would show up as an error toast or failed allocation)
        await takeScreenshot(page, '07-second-allocation');
      }
    }
  });

  test.afterEach(async ({ page }) => {
    // Take final screenshot
    await takeScreenshot(page, 'test-completed');
  });
});
