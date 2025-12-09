/**
 * Test: Invalid Consultant ID
 * Category: 04 - Validation Scenarios
 *
 * Scenario: Attempt to book with malformed or empty consultant ID
 * Expected: Lock layer accepts any string keys (validation happens at API layer)
 *
 * This test validates that the lock layer handles arbitrary consultant IDs gracefully.
 * Note: In production, the API would reject invalid IDs before reaching the lock layer.
 * This test confirms the lock mechanism itself doesn't break on unusual inputs.
 *
 * Each consultant ID is unique, so each booking goes to a different "slot":
 * - "":2025-12-16T11:00:00.000Z
 * - "null":2025-12-16T11:00:00.000Z
 * - "invalid-@#$%":2025-12-16T11:00:00.000Z
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
    consultantId: "various-invalid",
    // Each request uses a different consultant ID, so each gets a unique lock key
    // Lock layer doesn't validate - all 3 succeed with their own unique slots
    expectedSuccesses: 3,
    expectedConflicts: 0,
    expectedErrors: 0,
  };

  const slot = generateTestSlot(7, 11, 0);

  config.slotTime = slot.start;

  logTestStart(config.testName, {
    Category: config.category,
    "Test Cases": "Empty string, null-like, malformed ID",
    "Slot Time": new Date(slot.start).toLocaleString(),
    "Expected Outcome":
      "All 3 succeed (different consultant IDs = different lock keys)",
  });

  const startTime = Date.now();

  const results: BookingResult[] = await Promise.all([
    simulateBookingAttempt(slot.start, "", generateUserId(1)), // Empty consultant ID
    simulateBookingAttempt(slot.start, "null", generateUserId(2)), // Null-like string
    simulateBookingAttempt(slot.start, "invalid-@#$%", generateUserId(3)), // Malformed ID
  ]);

  const duration = Date.now() - startTime;

  // Lock layer accepts any string keys - validation happens at API layer in production
  // Each consultant ID creates a unique lock key, so all 3 requests succeed
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
