/**
 * Page Object Model and selectors for calendar and booking components
 */

import { Page, Locator } from '@playwright/test';

export class CalendarPage {
  readonly page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  /**
   * Get "Timings" button for an appointment
   */
  getTimingsButton(appointmentIndex: number = 0): Locator {
    return this.page.locator('button:has-text("Timings")').nth(appointmentIndex);
  }

  /**
   * Click "Timings" button to open timings modal
   */
  async openTimingsModal(appointmentIndex: number = 0) {
    const button = this.getTimingsButton(appointmentIndex);
    await button.click();
    await this.page.waitForTimeout(1000);
    // Wait for modal to appear
    await this.page.waitForSelector('[role="dialog"]', { timeout: 5000 }).catch(() => {
      console.warn('Timings modal not found');
    });
  }

  /**
   * Get calendar container (look in modal first, then page)
   */
  get calendar(): Locator {
    // Try modal first
    const modalCalendar = this.page.locator('[role="dialog"] [data-testid="calendar-view"], [role="dialog"] .calendar, [role="dialog"] [class*="calendar"]').first();
    if (modalCalendar) return modalCalendar;

    // Fallback to page-level calendar
    return this.page.locator('[data-testid="calendar-view"], .calendar, [class*="calendar"]').first();
  }

  /**
   * Get week view button
   */
  get weekViewButton(): Locator {
    return this.page.locator('button:has-text("Week")');
  }

  /**
   * Get month view button
   */
  get monthViewButton(): Locator {
    return this.page.locator('button:has-text("Month")');
  }

  /**
   * Get next week/month button
   */
  get nextButton(): Locator {
    return this.page.locator('[aria-label="Next week"], [aria-label="Next month"], button:has-text("Next")');
  }

  /**
   * Get previous week/month button
   */
  get previousButton(): Locator {
    return this.page.locator('[aria-label="Previous week"], [aria-label="Previous month"], button:has-text("Previous")');
  }

  /**
   * Get all slot cells (look in modal first)
   */
  get slotCells(): Locator {
    // Check if we're in a modal
    const modalSlots = this.page.locator('[role="dialog"] [class*="slot-cell"], [role="dialog"] [class*="slot"]');
    return modalSlots.first().isVisible().then(visible =>
      visible ? modalSlots : this.page.locator('[class*="slot-cell"], [class*="slot"]')
    ).catch(() => this.page.locator('[class*="slot-cell"], [class*="slot"]'));
  }

  /**
   * Get available slots (look in modal first)
   */
  get availableSlots(): Locator {
    return this.page.locator('[role="dialog"] .slot-cell:has-text("Available"), [role="dialog"] [data-status="available"], .slot-cell:has-text("Available"), [data-status="available"]');
  }

  /**
   * Get booked slots (look in modal first)
   */
  get bookedSlots(): Locator {
    return this.page.locator('[role="dialog"] .slot-cell:has-text("Booked"), [role="dialog"] [data-status="booked"], .slot-cell:has-text("Booked"), [data-status="booked"]');
  }

  /**
   * Get partially booked slots
   */
  get partiallyBookedSlots(): Locator {
    return this.page.locator('[role="dialog"] .slot-cell:has-text("Partially"), [role="dialog"] [data-status="partial"], .slot-cell:has-text("Partially"), [data-status="partial"]');
  }

  /**
   * Get a specific slot by date and time (look in modal first)
   */
  getSlot(date: string, time: string): Locator {
    return this.page.locator(`[role="dialog"] [data-date="${date}"][data-time="${time}"], [role="dialog"] [data-slot-date="${date}"][data-slot-time="${time}"], [data-date="${date}"][data-time="${time}"], [data-slot-date="${date}"][data-slot-time="${time}"]`).first();
  }

  /**
   * Click a specific slot
   */
  async clickSlot(date: string, time: string) {
    const slot = this.getSlot(date, time);
    await slot.click();
  }

  /**
   * Switch to week view
   */
  async switchToWeekView() {
    if (await this.weekViewButton.isVisible()) {
      await this.weekViewButton.click();
      await this.page.waitForTimeout(500);
    }
  }

  /**
   * Switch to month view
   */
  async switchToMonthView() {
    if (await this.monthViewButton.isVisible()) {
      await this.monthViewButton.click();
      await this.page.waitForTimeout(500);
    }
  }

  /**
   * Get all visible slot data
   */
  async getAllSlotData(): Promise<Array<{
    date: string | null;
    time: string | null;
    status: string;
    classes: string | null;
  }>> {
    const slots = await this.slotCells.all();
    const slotData = [];

    for (const slot of slots) {
      const date = await slot.getAttribute('data-date');
      const time = await slot.getAttribute('data-time');
      const status = await slot.textContent();
      const classes = await slot.getAttribute('class');

      slotData.push({ date, time, status: status || '', classes });
    }

    return slotData;
  }

  /**
   * Count slots by status
   */
  async countSlotsByStatus() {
    const availableCount = await this.availableSlots.count();
    const bookedCount = await this.bookedSlots.count();
    const partialCount = await this.partiallyBookedSlots.count();

    return {
      available: availableCount,
      booked: bookedCount,
      partial: partialCount,
      total: await this.slotCells.count(),
    };
  }
}

export class RequestsPage {
  readonly page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  /**
   * Get all request cards
   */
  get requestCards(): Locator {
    return this.page.locator('.request-card, [data-testid="request-card"]');
  }

  /**
   * Get consultation tab
   */
  get consultationsTab(): Locator {
    return this.page.locator('button:has-text("Consultations")');
  }

  /**
   * Get subscriptions tab
   */
  get subscriptionsTab(): Locator {
    return this.page.locator('button:has-text("Subscriptions")');
  }

  /**
   * Get classes tab
   */
  get classesTab(): Locator {
    return this.page.locator('button:has-text("Classes")');
  }

  /**
   * Get webinars tab
   */
  get webinarsTab(): Locator {
    return this.page.locator('button:has-text("Webinars")');
  }

  /**
   * Get a specific request card by ID
   */
  getRequestCard(id: string): Locator {
    return this.page.locator(`[data-consultation-id="${id}"], [data-subscription-id="${id}"], [data-request-id="${id}"]`);
  }

  /**
   * Get "Allocate Slots" button for a request (opens the allocation modal)
   */
  getAllocateSlotsButton(requestCard: Locator): Locator {
    return requestCard.locator('button:has-text("Allocate Slots"), button:has-text("Manage Timings")');
  }

  /**
   * Click "Allocate Slots" button to open allocation modal
   */
  async openAllocationModal(requestIndex: number = 0) {
    const card = this.requestCards.nth(requestIndex);
    const button = this.getAllocateSlotsButton(card);
    await button.click();
    await this.page.waitForTimeout(1000);
    // Wait for modal to appear
    await this.page.waitForSelector('[role="dialog"]', { timeout: 5000 }).catch(() => {
      console.warn('Allocation modal not found');
    });
  }

  /**
   * Get auto allocate button for a request (DEPRECATED - use AllocationModal)
   */
  getAutoAllocateButton(requestCard: Locator): Locator {
    return requestCard.locator('button:has-text("Auto Allocate")');
  }

  /**
   * Get manual allocate button for a request (DEPRECATED - use getAllocateSlotsButton)
   */
  getManualAllocateButton(requestCard: Locator): Locator {
    return requestCard.locator('button:has-text("Manual Allocate"), button:has-text("Manage Timings")');
  }

  /**
   * Click auto allocate for a specific request
   */
  async autoAllocateRequest(requestIndex: number = 0) {
    const card = this.requestCards.nth(requestIndex);
    const button = this.getAutoAllocateButton(card);
    await button.click();
    await this.page.waitForTimeout(2000);
  }

  /**
   * Click manual allocate for a specific request
   */
  async manualAllocateRequest(requestIndex: number = 0) {
    const card = this.requestCards.nth(requestIndex);
    const button = this.getManualAllocateButton(card);
    await button.click();
    await this.page.waitForTimeout(1000);
  }
}

export class AllocationModal {
  readonly page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  /**
   * Get modal dialog
   */
  get modal(): Locator {
    return this.page.locator('[role="dialog"]');
  }

  /**
   * Get allocate manual slots button
   */
  get allocateManualSlotsButton(): Locator {
    return this.page.locator('button:has-text("Allocate Manual Slots")');
  }

  /**
   * Get auto allocate button
   */
  get autoAllocateButton(): Locator {
    return this.page.locator('button:has-text("Auto Allocate")');
  }

  /**
   * Get clear selection button
   */
  get clearSelectionButton(): Locator {
    return this.page.locator('button:has-text("Clear Selection")');
  }

  /**
   * Get close button
   */
  get closeButton(): Locator {
    return this.page.locator('button:has-text("Close"), [aria-label="Close"]');
  }

  /**
   * Get selected slots
   */
  get selectedSlots(): Locator {
    return this.page.locator('[data-selected="true"], .slot-selected, [class*="selected"]');
  }

  /**
   * Wait for modal to be visible
   */
  async waitForModal() {
    await this.modal.waitFor({ state: 'visible', timeout: 10000 });
  }

  /**
   * Click allocate manual slots
   */
  async clickAllocateManualSlots() {
    await this.allocateManualSlotsButton.click();
    await this.page.waitForTimeout(1000);
  }

  /**
   * Click auto allocate
   */
  async clickAutoAllocate() {
    await this.autoAllocateButton.click();
    await this.page.waitForTimeout(2000);
  }

  /**
   * Clear all selected slots
   */
  async clearSelection() {
    await this.clearSelectionButton.click();
    await this.page.waitForTimeout(500);
  }

  /**
   * Close the modal
   */
  async close() {
    await this.closeButton.click();
    await this.modal.waitFor({ state: 'hidden', timeout: 5000 });
  }

  /**
   * Select multiple slots
   */
  async selectSlots(slots: Array<{ date: string; time: string }>) {
    for (const slot of slots) {
      const slotElement = this.page.locator(`[data-date="${slot.date}"][data-time="${slot.time}"]`);
      await slotElement.click();
      await this.page.waitForTimeout(200);
    }
  }

  /**
   * Get count of selected slots
   */
  async getSelectedSlotsCount(): Promise<number> {
    return await this.selectedSlots.count();
  }
}

export class ToastNotification {
  readonly page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  /**
   * Get toast element
   */
  get toast(): Locator {
    return this.page.locator('[role="alert"], .toast, [class*="toast"]').first();
  }

  /**
   * Wait for toast with specific text
   */
  async waitForToast(expectedText?: string): Promise<string | null> {
    try {
      await this.toast.waitFor({ state: 'visible', timeout: 5000 });
      const text = await this.toast.textContent();

      if (expectedText && text && !text.includes(expectedText)) {
        console.warn(`Expected toast: "${expectedText}", got: "${text}"`);
      }

      return text;
    } catch {
      return null;
    }
  }

  /**
   * Check if success toast is visible
   */
  async isSuccessToastVisible(): Promise<boolean> {
    const successToast = this.page.locator('[role="alert"]:has-text("Success"), .toast:has-text("Success")');
    return await successToast.isVisible();
  }

  /**
   * Check if error toast is visible
   */
  async isErrorToastVisible(): Promise<boolean> {
    const errorToast = this.page.locator('[role="alert"]:has-text("Error"), .toast:has-text("Error")');
    return await errorToast.isVisible();
  }
}
