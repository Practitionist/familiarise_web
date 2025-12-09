/**
 * Test: Invalid Consultant ID
 * Category: 04 - Validation Scenarios
 *
 * Scenario: Attempt to book with malformed or empty consultant ID
 * Expected: System handles gracefully (may produce errors or specific behavior)
 *
 * This test validates input validation for consultant identifiers.
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
import { generateTestSlot, generateUserId } from "../../utilities/fixtures.js";
import type {
  TestConfig,
  SummaryReport,
  BookingResult,
} from "../../utilities/types.js";

async function runTest() {
  resetBookingRegistry();

  const config: TestConfig = {
    testName: "Invalid Consultant ID",
    category: "04-validation-scenarios",
    concurrentUsers: 3,
    slotTime: "",
    consultantId: "invalid",
    expectedSuccesses: 0,
    expectedConflicts: 0,
    expectedErrors: 3,
  };

  const slot = generateTestSlot(7, 11, 0);

  config.slotTime = slot.start;

  logTestStart(config.testName, {
    Category: config.category,
    "Test Cases": "Empty string, null-like, malformed ID",
    "Slot Time": new Date(slot.start).toLocaleString(),
    "Expected Outcome": "All requests should handle gracefully",
  });

  const startTime = Date.now();

  const results: BookingResult[] = await Promise.all([
    simulateBookingAttempt(slot.start, "", generateUserId(1)), // Empty consultant ID
    simulateBookingAttempt(slot.start, "null", generateUserId(2)), // Null-like string
    simulateBookingAttempt(slot.start, "invalid-@#$%", generateUserId(3)), // Malformed ID
  ]);

  const duration = Date.now() - startTime;

  // For this test, we expect all to succeed with locking (validation is minimal in test)
  // In production, API would reject these before reaching lock layer
  const report = generateTestReport(config, results, duration);
  logTestResult(report);

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  await saveJsonReport(
    report,
    `04-validation-scenarios/test-invalid-consultant-${timestamp}.json`,
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
    `test-invalid-consultant-${timestamp}.md`,
  );

  process.exit(report.passed ? 0 : 1);
}

runTest().catch((error) => {
  console.error("\n❌ Test execution failed:");
  console.error(error);
  process.exit(1);
});
