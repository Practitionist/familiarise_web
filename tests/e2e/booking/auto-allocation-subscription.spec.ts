/**
 * Auto-Allocation Subscription Tests
 * Based on test specifications in prompts/1.txt and prompts/2.txt
 *
 * Tests verify that the subscription auto-allocation algorithm correctly:
 * - Enforces weekly limits (max callsPerWeek calls per week)
 * - Ensures max 1 call per day
 * - Distributes calls across the subscription duration
 * - Creates multiple appointments (one per call)
 */

import { requestsTest as test, expect } from '../fixtures/test-data';
import { verifyWeeklyDistribution } from '../helpers/database';
import { takeScreenshot } from '../helpers/auth';
import prisma from '../helpers/database';

test.describe('Auto-Allocation Subscription Tests', () => {
  test('Test 2.4: Subscription Weekly Limit Enforcement', async ({
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

    // Step 1: Switch to subscriptions tab
    await requestsPage.subscriptionsTab.click();
    await page.waitForTimeout(1000);

    await takeScreenshot(page, '08-subscriptions-tab');

    // Step 2: Find pending subscription
    const requestCards = await requestsPage.requestCards.count();
    console.log(`Found ${requestCards} subscription request(s)`);

    if (requestCards === 0) {
      test.skip();
      return;
    }

    // Step 3: Get subscription details from first card
    // (In a real test, we'd parse the card to get the subscription ID)

    // Find pending approved subscription from database
    const pendingSubscription = await prisma.subscription.findFirst({
      where: {
        subscriptionPlan: {
          consultantProfileId: consultantInfo.consultantProfileId,
        },
        requestStatus: 'APPROVED',
        appointments: {
          none: {}, // No appointments yet
        },
      },
      include: {
        subscriptionPlan: true,
        requestedBy: {
          include: {
            user: true,
          },
        },
      },
    });

    if (!pendingSubscription) {
      test.skip();
      return;
    }

    console.log('Found pending subscription:', {
      id: pendingSubscription.id,
      title: pendingSubscription.subscriptionPlan.title,
      callsPerWeek: pendingSubscription.subscriptionPlan.callsPerWeek,
      durationInMonths: pendingSubscription.subscriptionPlan.durationInMonths,
      sessionDuration: pendingSubscription.subscriptionPlan.sessionDurationInHours,
    });

    // Step 4: Open allocation modal and click auto allocate
    await requestsPage.openAllocationModal(0);
    await allocationModal.clickAutoAllocate();

    // Step 5: Wait for allocation (may take longer for subscriptions)
    console.log('Waiting for subscription allocation...');
    await page.waitForTimeout(3000);

    // Step 6: Check for toast
    const toastText = await toastNotification.waitForToast();
    console.log('Toast notification:', toastText);

    await takeScreenshot(page, '08-after-subscription-allocation');

    // Step 7: Verify weekly distribution
    const weeklyDistribution = await verifyWeeklyDistribution(pendingSubscription.id);

    console.log('Weekly distribution:', weeklyDistribution);

    // Step 8: Validate constraints
    let hasViolation = false;

    for (const week of weeklyDistribution) {
      console.log(`Week ${week.weekStart}:`, {
        calls: week.totalCalls,
        days: week.uniqueDaysInWeek,
        status: week.validationStatus,
      });

      // Check weekly limit
      if (week.totalCalls > pendingSubscription.subscriptionPlan.callsPerWeek) {
        console.error(`❌ Week exceeds limit: ${week.totalCalls} > ${pendingSubscription.subscriptionPlan.callsPerWeek}`);
        hasViolation = true;
      }

      // Check max 1 call per day
      if (week.uniqueDaysInWeek < week.totalCalls) {
        console.error(`❌ Multiple calls on same day in week ${week.weekStart}`);
        hasViolation = true;
      }

      // Verify each week has correct limit
      expect(week.totalCalls).toBeLessThanOrEqual(pendingSubscription.subscriptionPlan.callsPerWeek);

      // Verify unique days (no multiple calls same day)
      expect(week.uniqueDaysInWeek).toBeGreaterThanOrEqual(week.totalCalls);
    }

    if (hasViolation) {
      await takeScreenshot(page, '08-weekly-limit-violation');
      throw new Error('Weekly limit or same-day violation detected!');
    }

    console.log('✅ Subscription weekly limits validated successfully!');
  });

  test('Test 2.5: Subscription Total Call Count', async ({
    page,
    consultantInfo,
  }) => {
    if (!consultantInfo) {
      test.skip();
      return;
    }

    // Find an allocated subscription
    const allocatedSubscription = await prisma.subscription.findFirst({
      where: {
        subscriptionPlan: {
          consultantProfileId: consultantInfo.consultantProfileId,
        },
        requestStatus: 'SCHEDULED',
        appointments: {
          some: {}, // Has appointments
        },
      },
      include: {
        subscriptionPlan: true,
        appointments: {
          include: {
            slotsOfAppointment: true,
          },
        },
      },
    });

    if (!allocatedSubscription) {
      test.skip();
      return;
    }

    console.log('Analyzing allocated subscription:', {
      id: allocatedSubscription.id,
      title: allocatedSubscription.subscriptionPlan.title,
      callsPerWeek: allocatedSubscription.subscriptionPlan.callsPerWeek,
      durationInMonths: allocatedSubscription.subscriptionPlan.durationInMonths,
    });

    // Calculate expected total calls
    const startDate = new Date(allocatedSubscription.startDate);
    const endDate = new Date(allocatedSubscription.endDate);

    const durationInDays = Math.ceil((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24));
    const durationInWeeks = Math.ceil(durationInDays / 7);

    const expectedTotalCalls = durationInWeeks * allocatedSubscription.subscriptionPlan.callsPerWeek;

    console.log('Duration calculation:', {
      startDate: startDate.toISOString(),
      endDate: endDate.toISOString(),
      durationInDays,
      durationInWeeks,
      expectedTotalCalls,
    });

    // Count actual appointments
    const actualAppointments = allocatedSubscription.appointments.length;

    console.log('Actual appointments:', actualAppointments);

    // Tolerance: ±1 appointment due to rounding
    expect(actualAppointments).toBeGreaterThanOrEqual(expectedTotalCalls - 1);
    expect(actualAppointments).toBeLessThanOrEqual(expectedTotalCalls + 1);

    console.log('✅ Total call count validated!');
  });

  test('Test 2.6: Subscription Session Duration', async ({
    page,
    consultantInfo,
  }) => {
    if (!consultantInfo) {
      test.skip();
      return;
    }

    // Find an allocated subscription
    const allocatedSubscription = await prisma.subscription.findFirst({
      where: {
        subscriptionPlan: {
          consultantProfileId: consultantInfo.consultantProfileId,
        },
        requestStatus: 'SCHEDULED',
        appointments: {
          some: {}, // Has appointments
        },
      },
      include: {
        subscriptionPlan: true,
        appointments: {
          include: {
            slotsOfAppointment: true,
          },
          take: 1, // Just check one appointment
        },
      },
    });

    if (!allocatedSubscription || allocatedSubscription.appointments.length === 0) {
      test.skip();
      return;
    }

    const firstAppointment = allocatedSubscription.appointments[0];
    const slotCount = firstAppointment.slotsOfAppointment.length;
    const expectedSlots = Math.ceil(allocatedSubscription.subscriptionPlan.sessionDurationInHours * 2);

    console.log('Session duration check:', {
      sessionDuration: allocatedSubscription.subscriptionPlan.sessionDurationInHours,
      expectedSlots,
      actualSlots: slotCount,
    });

    // Each appointment should have correct number of slots
    expect(slotCount).toBe(expectedSlots);

    console.log('✅ Session duration validated!');
  });

  test.afterEach(async ({ page }) => {
    await takeScreenshot(page, 'subscription-test-completed');
  });
});
