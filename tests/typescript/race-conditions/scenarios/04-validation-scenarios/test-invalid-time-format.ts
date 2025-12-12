/**
 * Test: Invalid Time Format
 * Category: 04 - Validation Scenarios
 *
 * Scenario: Attempt to book with malformed time strings
 * Expected: Lock layer accepts any string keys (validation happens at API layer)
 *
 * This test validates that the lock layer handles arbitrary time formats gracefully.
 * Note: In production, the API would reject invalid times before reaching the lock layer.
 * This test confirms the lock mechanism itself doesn't break on unusual inputs.
 *
 * Each time string is unique, so each booking goes to a different "slot":
 * - consultant-123:not-a-date
 * - consultant-123: (empty)
 * - consultant-123:2024-13-45T99:99:99
 *
 * Expected: 3 successes (each is a unique slot key)
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
    testName: "Invalid Time Format",
    category: "04-validation-scenarios",
    concurrentUsers: 3,
    slotTime: "various-invalid",
    consultantId: "",
    // Each request uses a different time string, so each gets a unique lock key
    // Lock layer doesn't validate - all 3 succeed with their own unique slots
    expectedSuccesses: 3,
    expectedConflicts: 0,
    expectedErrors: 0,
  };

  const consultantId = generateConsultantId();
  config.consultantId = consultantId;

  logTestStart(config.testName, {
    Category: config.category,
    "Test Cases": "Invalid date string, empty, malformed ISO",
    "Consultant ID": consultantId,
    "Expected Outcome":
      "All 3 succeed (different time strings = different lock keys)",
  });

  const startTime = Date.now();

  const results: BookingResult[] = await Promise.all([
    simulateBookingAttempt("not-a-date", consultantId, generateUserId(1)),
    simulateBookingAttempt("", consultantId, generateUserId(2)),
    simulateBookingAttempt(
      "2024-13-45T99:99:99",
      consultantId,
      generateUserId(3),
    ),
  ]);

  const duration = Date.now() - startTime;

  const report = generateTestReport(config, results, duration);
  logTestResult(report);

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  await saveJsonReport(
    report,
    `04-validation-scenarios/test-invalid-time-format-${timestamp}.json`,
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
    `test-invalid-time-format-${timestamp}.md`,
  );

  process.exit(report.passed ? 0 : 1);
}

runTest().catch((error) => {
  console.error("\n❌ Test execution failed:");
  console.error(error);
  process.exit(1);
});
