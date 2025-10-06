/**
 * Test data fixtures and setup utilities
 */

import { test as base } from '@playwright/test';
import { CalendarPage, RequestsPage, AllocationModal, ToastNotification } from '../helpers/selectors';
import { loginAsConsultant, navigateToAppointmentsTab, navigateToRequestsTab } from '../helpers/auth';
import { findTestConsultant, ConsultantInfo, closeDatabaseConnection } from '../helpers/database';

/**
 * Extended test fixture with common page objects and setup
 */
export const test = base.extend<{
  calendarPage: CalendarPage;
  requestsPage: RequestsPage;
  allocationModal: AllocationModal;
  toastNotification: ToastNotification;
  consultantInfo: ConsultantInfo | null;
}>({
  // Calendar page object
  calendarPage: async ({ page }, use) => {
    const calendarPage = new CalendarPage(page);
    await use(calendarPage);
  },

  // Requests page object
  requestsPage: async ({ page }, use) => {
    const requestsPage = new RequestsPage(page);
    await use(requestsPage);
  },

  // Allocation modal object
  allocationModal: async ({ page }, use) => {
    const allocationModal = new AllocationModal(page);
    await use(allocationModal);
  },

  // Toast notification object
  toastNotification: async ({ page }, use) => {
    const toastNotification = new ToastNotification(page);
    await use(toastNotification);
  },

  // Consultant info from database
  consultantInfo: async ({}, use) => {
    const consultant = await findTestConsultant();
    await use(consultant);
  },
});

/**
 * Test fixture for authenticated consultant tests
 */
export const consultantTest = test.extend({
  page: async ({ page }, use) => {
    // Login as consultant before each test
    await loginAsConsultant(page);
    await use(page);
  },
});

/**
 * Test fixture for appointments page tests
 */
export const appointmentsTest = consultantTest.extend({
  page: async ({ page, consultantInfo }, use) => {
    if (!consultantInfo) {
      throw new Error('No test consultant found in database');
    }

    // Navigate to appointments page
    await navigateToAppointmentsTab(page, consultantInfo.consultantProfileId);
    await use(page);
  },
});

/**
 * Test fixture for requests page tests
 */
export const requestsTest = consultantTest.extend({
  page: async ({ page, consultantInfo }, use) => {
    if (!consultantInfo) {
      throw new Error('No test consultant found in database');
    }

    // Navigate to requests page
    await navigateToRequestsTab(page, consultantInfo.consultantProfileId);
    await use(page);
  },
});

/**
 * Cleanup hook - runs after all tests
 */
test.afterAll(async () => {
  await closeDatabaseConnection();
});

export { expect } from '@playwright/test';
