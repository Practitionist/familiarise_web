/**
 * Date utility functions for consistent date calculations across the application
 */

/**
 * Adds months to a date while properly handling month-end overflow issues.
 *
 * Examples:
 * - Jan 31 + 1 month = Feb 28/29 (not Mar 3)
 * - Mar 31 + 1 month = Apr 30 (not May 1)
 * - Jan 15 + 1 month = Feb 15
 *
 * @param date - The starting date
 * @param months - Number of months to add
 * @returns New date with months added
 */
export function addMonthsSafely(date: Date, months: number): Date {
  const result = new Date(date);
  const targetMonth = result.getMonth() + months;
  result.setMonth(targetMonth);

  // If the day overflowed to the next month, set it back to the last day of the target month
  if (result.getMonth() !== targetMonth % 12) {
    result.setDate(0); // Move to last day of previous month
  }

  return result;
}

/**
 * Calculates the end date for a subscription based on start date and duration.
 * Uses safe month addition to avoid overflow issues.
 *
 * @param startDate - Subscription start date
 * @param durationInMonths - Duration in months
 * @returns Subscription end date
 */
export function calculateSubscriptionEndDate(
  startDate: Date,
  durationInMonths: number,
): Date {
  return addMonthsSafely(startDate, durationInMonths);
}

/**
 * Validates that two dates are consecutive with tolerance for timezone/precision issues.
 *
 * @param firstDate - First date
 * @param secondDate - Second date (should be after firstDate)
 * @param toleranceMs - Tolerance in milliseconds (default: 1000ms)
 * @returns True if dates are consecutive within tolerance
 */
export function areDatesConsecutive(
  firstDate: Date,
  secondDate: Date,
  toleranceMs: number = 1000,
): boolean {
  const timeDiff = Math.abs(secondDate.getTime() - firstDate.getTime());
  return timeDiff <= toleranceMs;
}

/**
 * Validates that an array of dates are consecutive with tolerance.
 *
 * @param dates - Array of dates (should be sorted)
 * @param toleranceMs - Tolerance in milliseconds (default: 1000ms)
 * @returns True if all dates are consecutive
 */
export function areDatesConsecutiveArray(
  dates: Date[],
  toleranceMs: number = 1000,
): boolean {
  if (dates.length <= 1) return true;

  for (let i = 1; i < dates.length; i++) {
    if (!areDatesConsecutive(dates[i - 1], dates[i], toleranceMs)) {
      return false;
    }
  }

  return true;
}
