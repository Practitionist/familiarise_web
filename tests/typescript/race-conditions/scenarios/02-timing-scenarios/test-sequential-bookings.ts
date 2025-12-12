/**
 * Test: Sequential Bookings (No Overlap Expected)
 * Category: 02 - Timing Scenarios
 *
 * Scenario: Users book the same slot one after another (not concurrently)
 * Expected: First user succeeds (201), second user gets conflict (409)
 *
 * This test validates that the booking registry works correctly for
 * sequential (non-concurrent) requests.
 */

import {
  simulateBookingAttempt,
  generateTestReport,
  logTestStart,
  logTestResult,
  saveJsonReport,
  saveMarkdownReport,
  generateMarkdownReport,
  resetBookingRegistry,
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
    testName: "Sequential Bookings (No Overlap Expected)",
    category: "02-timing-scenarios",
    concurrentUsers: 2,
    slotTime: "",
    consultantId: "",
    expectedSuccesses: 1,
    expectedConflicts: 1,
    expectedErrors: 0,
  };

  const slot = generateTestSlot(7, 13, 0); // 1:00 PM
  const consultantId = generateConsultantId();
  const user1 = generateUserId(1);
  const user2 = generateUserId(2);

  config.slotTime = slot.start;
  config.consultantId = consultantId;

  logTestStart(config.testName, {
    Category: config.category,
    "Sequential Users": config.concurrentUsers,
    "Slot Time": new Date(slot.start).toLocaleString(),
    "Consultant ID": consultantId,
    "Expected Outcome": `${config.expectedSuccesses} success, ${config.expectedConflicts} conflicts (sequential execution)`,
  });

  const startTime = Date.now();

  // Execute bookings sequentially (not concurrently)
  const result1 = await simulateBookingAttempt(slot.start, consultantId, user1);
  const result2 = await simulateBookingAttempt(slot.start, consultantId, user2);

  const results: BookingResult[] = [result1, result2];
  const duration = Date.now() - startTime;

  const report = generateTestReport(config, results, duration);
  logTestResult(report);

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  await saveJsonReport(
    report,
    `02-timing-scenarios/test-sequential-bookings-${timestamp}.json`,
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
    `test-sequential-bookings-${timestamp}.md`,
  );

  process.exit(report.passed ? 0 : 1);
}

runTest().catch((error) => {
  console.error("\n❌ Test execution failed:");
  console.error(error);
  process.exit(1);
});
