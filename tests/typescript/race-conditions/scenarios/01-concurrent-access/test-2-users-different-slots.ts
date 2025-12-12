/**
 * Test: 2 Users Booking Different Slots (Same Consultant)
 * Category: 01 - Concurrent Access Patterns
 *
 * Scenario: Two users book different time slots for the same consultant simultaneously
 * Expected: Both users succeed (201), no conflicts
 *
 * This test validates that slot-level locking allows concurrent bookings
 * for different slots with the same consultant (good concurrency).
 */

import {
  generateTestReport,
  logTestStart,
  logTestResult,
  saveJsonReport,
  saveMarkdownReport,
  generateMarkdownReport,
  resetBookingRegistry,
  simulateBookingAttempt,
} from "../../utilities/test-helpers.js";
import {
  generateTestSlot,
  generateConsultantId,
  generateUserId,
} from "../../utilities/fixtures.js";
import type {
  TestConfig,
  SummaryReport,
  BookingResult,
} from "../../utilities/types.js";

async function runTest() {
  resetBookingRegistry();

  const config: TestConfig = {
    testName: "2 Users Booking Different Slots (Same Consultant)",
    category: "01-concurrent-access",
    concurrentUsers: 2,
    slotTime: "multiple",
    consultantId: "",
    expectedSuccesses: 2,
    expectedConflicts: 0,
    expectedErrors: 0,
  };

  const slot1 = generateTestSlot(7, 10, 0); // 10:00 AM
  const slot2 = generateTestSlot(7, 11, 0); // 11:00 AM (different slot)
  const consultantId = generateConsultantId();
  const user1 = generateUserId(1);
  const user2 = generateUserId(2);

  config.consultantId = consultantId;

  logTestStart(config.testName, {
    Category: config.category,
    "Concurrent Users": config.concurrentUsers,
    "Slot 1 Time": new Date(slot1.start).toLocaleString(),
    "Slot 2 Time": new Date(slot2.start).toLocaleString(),
    "Consultant ID": consultantId,
    "Expected Outcome": `${config.expectedSuccesses} successes, ${config.expectedConflicts} conflicts`,
  });

  const startTime = Date.now();

  // Execute concurrent bookings for different slots
  const results: BookingResult[] = await Promise.all([
    simulateBookingAttempt(slot1.start, consultantId, user1),
    simulateBookingAttempt(slot2.start, consultantId, user2),
  ]);

  const duration = Date.now() - startTime;

  const report = generateTestReport(config, results, duration);
  logTestResult(report);

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  await saveJsonReport(
    report,
    `01-concurrent-access/test-2-users-different-slots-${timestamp}.json`,
  );

  const summaryReport: SummaryReport = {
    totalTests: 1,
    passedTests: report.passed ? 1 : 0,
    failedTests: report.passed ? 0 : 1,
    totalDuration: duration,
    categories: [
      {
        category: config.category,
        totalTests: 1,
        passedTests: report.passed ? 1 : 0,
        failedTests: report.passed ? 0 : 1,
        duration: duration,
        tests: [report],
      },
    ],
    timestamp: report.timestamp,
    mode: "sequential",
  };

  const markdownContent = generateMarkdownReport(summaryReport);
  await saveMarkdownReport(
    markdownContent,
    `test-2-users-different-slots-${timestamp}.md`,
  );

  process.exit(report.passed ? 0 : 1);
}

runTest().catch((error) => {
  console.error("\n❌ Test execution failed:");
  console.error(error);
  process.exit(1);
});
