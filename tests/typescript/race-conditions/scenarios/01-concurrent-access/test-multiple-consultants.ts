/**
 * Test: Multiple Consultants with Overlapping Bookings
 * Category: 01 - Concurrent Access Patterns
 *
 * Scenario: Multiple users book the same time slot but with different consultants
 * Expected: All users succeed (201), no conflicts
 *
 * This test validates that the locking mechanism correctly isolates
 * bookings by consultant (consultant-specific locking).
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
    testName: "Multiple Consultants with Overlapping Bookings",
    category: "01-concurrent-access",
    concurrentUsers: 3,
    slotTime: "",
    consultantId: "multiple",
    expectedSuccesses: 3,
    expectedConflicts: 0,
    expectedErrors: 0,
  };

  const slot = generateTestSlot(7, 15, 0); // Same slot time for all
  const consultant1 = generateConsultantId(1);
  const consultant2 = generateConsultantId(2);
  const consultant3 = generateConsultantId(3);
  const user1 = generateUserId(1);
  const user2 = generateUserId(2);
  const user3 = generateUserId(3);

  config.slotTime = slot.start;

  logTestStart(config.testName, {
    Category: config.category,
    "Concurrent Users": config.concurrentUsers,
    "Slot Time": new Date(slot.start).toLocaleString(),
    "Consultant 1": consultant1,
    "Consultant 2": consultant2,
    "Consultant 3": consultant3,
    "Expected Outcome": `${config.expectedSuccesses} successes, ${config.expectedConflicts} conflicts`,
  });

  const startTime = Date.now();

  // Execute concurrent bookings for different consultants
  const results: BookingResult[] = await Promise.all([
    simulateBookingAttempt(slot.start, consultant1, user1),
    simulateBookingAttempt(slot.start, consultant2, user2),
    simulateBookingAttempt(slot.start, consultant3, user3),
  ]);

  const duration = Date.now() - startTime;

  const report = generateTestReport(config, results, duration);
  logTestResult(report);

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  await saveJsonReport(
    report,
    `01-concurrent-access/test-multiple-consultants-${timestamp}.json`,
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
    `test-multiple-consultants-${timestamp}.md`,
  );

  process.exit(report.passed ? 0 : 1);
}

runTest().catch((error) => {
  console.error("\n❌ Test execution failed:");
  console.error(error);
  process.exit(1);
});
