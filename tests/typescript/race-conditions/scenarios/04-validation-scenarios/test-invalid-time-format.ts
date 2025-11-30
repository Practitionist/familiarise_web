/**
 * Test: Invalid Time Format
 * Category: 04 - Validation Scenarios
 *
 * Scenario: Attempt to book with malformed time strings
 * Expected: System handles gracefully
 *
 * This test validates input validation for time slot formats.
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
    slotTime: "invalid",
    consultantId: "",
    expectedSuccesses: 0,
    expectedConflicts: 0,
    expectedErrors: 3,
  };

  const consultantId = generateConsultantId();
  config.consultantId = consultantId;

  logTestStart(config.testName, {
    Category: config.category,
    "Test Cases": "Invalid date string, empty, malformed ISO",
    "Consultant ID": consultantId,
    "Expected Outcome": "All requests handle invalid time formats gracefully",
  });

  const startTime = Date.now();

  const results: BookingResult[] = await Promise.all([
    simulateBookingAttempt("not-a-date", consultantId, generateUserId(1)),
    simulateBookingAttempt("", consultantId, generateUserId(2)),
    simulateBookingAttempt("2024-13-45T99:99:99", consultantId, generateUserId(3)),
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
