/**
 * Authentication helper utilities for Playwright tests
 */

import { Page } from '@playwright/test';

export interface LoginCredentials {
  email: string;
  password: string;
}

/**
 * Login to the application
 */
export async function login(page: Page, credentials: LoginCredentials) {
  await page.goto('/auth/signin');

  // Wait for login form to be visible
  await page.waitForSelector('input[name="email"], input[type="email"]', { timeout: 10000 });

  // Fill in credentials
  const emailInput = page.locator('input[name="email"], input[type="email"]').first();
  const passwordInput = page.locator('input[name="password"], input[type="password"]').first();

  await emailInput.fill(credentials.email);
  await passwordInput.fill(credentials.password);

  // Submit form
  const submitButton = page.locator('button[type="submit"]').first();
  await submitButton.click();

  // Wait for login to complete (may redirect to homepage or dashboard)
  await page.waitForLoadState('networkidle', { timeout: 15000 });

  // Check if we're on homepage or dashboard
  const currentUrl = page.url();
  console.log('After login, current URL:', currentUrl);

  // If not already on dashboard, we'll navigate there in the test fixtures
}

/**
 * Login as consultant
 */
export async function loginAsConsultant(page: Page) {
  const credentials: LoginCredentials = {
    email: process.env.TEST_CONSULTANT_EMAIL || 'consultant@test.com',
    password: process.env.TEST_CONSULTANT_PASSWORD || 'Test@123',
  };

  await login(page, credentials);
}

/**
 * Login as consultee
 */
export async function loginAsConsultee(page: Page) {
  const credentials: LoginCredentials = {
    email: process.env.TEST_CONSULTEE_EMAIL || 'consultee@test.com',
    password: process.env.TEST_CONSULTEE_PASSWORD || 'Test@123',
  };

  await login(page, credentials);
}

/**
 * Logout from the application
 */
export async function logout(page: Page) {
  // Try to find and click logout button
  const logoutButton = page.locator('button:has-text("Logout"), button:has-text("Sign out")').first();

  if (await logoutButton.isVisible()) {
    await logoutButton.click();
    await page.waitForURL('**/auth/**', { timeout: 5000 });
  }
}

/**
 * Check if user is logged in
 */
export async function isLoggedIn(page: Page): Promise<boolean> {
  const url = page.url();
  return url.includes('/dashboard/');
}

/**
 * Navigate to consultant dashboard
 */
export async function navigateToConsultantDashboard(page: Page, consultantId: string) {
  await page.goto(`/dashboard/consultant/${consultantId}`);
  await page.waitForLoadState('networkidle');
}

/**
 * Navigate to appointments tab
 */
export async function navigateToAppointmentsTab(page: Page, consultantId: string) {
  await page.goto(`/dashboard/consultant/${consultantId}/appointments`);
  await page.waitForLoadState('networkidle');

  // Wait for calendar to render
  await page.waitForSelector('[data-testid="calendar-view"], .calendar, [class*="calendar"]', {
    timeout: 10000,
    state: 'visible'
  }).catch(() => {
    console.warn('Calendar selector not found, continuing...');
  });
}

/**
 * Navigate to requests tab
 */
export async function navigateToRequestsTab(page: Page, consultantId: string) {
  await page.goto(`/dashboard/consultant/${consultantId}/requests`);
  await page.waitForLoadState('networkidle');
}

/**
 * Navigate to planner tab
 */
export async function navigateToPlannerTab(page: Page, consultantId: string) {
  await page.goto(`/dashboard/consultant/${consultantId}/planner`);
  await page.waitForLoadState('networkidle');
}

/**
 * Take a screenshot with a descriptive name
 */
export async function takeScreenshot(page: Page, name: string) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  await page.screenshot({
    path: `test-screenshots/${name}-${timestamp}.png`,
    fullPage: true,
  });
}

/**
 * Wait for toast notification
 */
export async function waitForToast(page: Page, expectedText?: string): Promise<string | null> {
  try {
    const toast = page.locator('[role="alert"], .toast, [class*="toast"]').first();
    await toast.waitFor({ state: 'visible', timeout: 5000 });

    const toastText = await toast.textContent();

    if (expectedText && toastText && !toastText.includes(expectedText)) {
      console.warn(`Expected toast to contain "${expectedText}" but got "${toastText}"`);
    }

    return toastText;
  } catch (error) {
    console.warn('No toast notification found');
    return null;
  }
}

/**
 * Wait for loading to complete
 */
export async function waitForLoadingToComplete(page: Page) {
  // Wait for any loading indicators to disappear
  await page.waitForSelector('[role="progressbar"], .loading, [class*="loading"]', {
    state: 'hidden',
    timeout: 5000,
  }).catch(() => {
    // No loading indicator found, continue
  });

  await page.waitForLoadState('networkidle');
}
