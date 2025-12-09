/**
 * Test: Rapid-Fire Requests from Same User
 * Category: 02 - Timing Scenarios
 *
 * Scenario: Same user makes 3 rapid requests for the same slot (double-click scenario)
 * Expected: First request succeeds (201), remaining get conflicts (409)
 *
 * This test simulates accidental double-clicks or rapid retries from
 * the same user attempting to book the same slot.
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
    testName: "Rapid-Fire Requests from Same User",
    category: "02-timing-scenarios",
    concurrentUsers: 3,
    slotTime: "",
    consultantId: "",
    expectedSuccesses: 1,
    expectedConflicts: 2,
    expectedErrors: 0,
  };

  const slot = generateTestSlot(7, 9, 30); // 9:30 AM
  const consultantId = generateConsultantId();
  const userId = generateUserId(1); // Same user ID for all requests

  config.slotTime = slot.start;
  config.consultantId = consultantId;

  logTestStart(config.testName, {
    Category: config.category,
    "Rapid Requests": config.concurrentUsers,
    "User ID": userId,
    "Slot Time": new Date(slot.start).toLocaleString(),
    "Consultant ID": consultantId,
    "Expected Outcome": `${config.expectedSuccesses} success, ${config.expectedConflicts} conflicts (same user)`,
  });

  const startTime = Date.now();

  // Simulate rapid-fire requests from the same user
  const results: BookingResult[] = await Promise.all([
    simulateBookingAttempt(slot.start, consultantId, userId),
    simulateBookingAttempt(slot.start, consultantId, userId),
    simulateBookingAttempt(slot.start, consultantId, userId),
  ]);

  const duration = Date.now() - startTime;

  const report = generateTestReport(config, results, duration);
  logTestResult(report);

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  await saveJsonReport(
    report,
    `02-timing-scenarios/test-rapid-fire-same-user-${timestamp}.json`,
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
    `test-rapid-fire-same-user-${timestamp}.md`,
  );

  process.exit(report.passed ? 0 : 1);
}

runTest().catch((error) => {
  console.error("\n❌ Test execution failed:");
  console.error(error);
  process.exit(1);
});
