/**
 * Test: Past Slot Booking Attempt
 * Category: 04 - Validation Scenarios
 *
 * Scenario: Attempt to book a slot in the past
 * Expected: System should handle gracefully (locks still work, validation may reject)
 *
 * This test validates handling of past date/time bookings.
 */

import {
  executeConcurrentBookings,
  generateTestReport,
  logTestStart,
  logTestResult,
  saveJsonReport,
  saveMarkdownReport,
  generateMarkdownReport,
  resetBookingRegistry,
} from "../../utilities/test-helpers.js";
import { generateConsultantId } from "../../utilities/fixtures.js";
import type { TestConfig, SummaryReport } from "../../utilities/types.js";

async function runTest() {
  resetBookingRegistry();

  const config: TestConfig = {
    testName: "Past Slot Booking Attempt",
    category: "04-validation-scenarios",
    concurrentUsers: 2,
    slotTime: "",
    consultantId: "",
    expectedSuccesses: 1,
    expectedConflicts: 1,
    expectedErrors: 0,
  };

  // Generate a past slot (yesterday)
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  yesterday.setHours(10, 0, 0, 0);
  const pastSlot = yesterday.toISOString();

  const consultantId = generateConsultantId();

  config.slotTime = pastSlot;
  config.consultantId = consultantId;

  logTestStart(config.testName, {
    Category: config.category,
    "Concurrent Users": config.concurrentUsers,
    "Slot Time": new Date(pastSlot).toLocaleString() + " (PAST)",
    "Consultant ID": consultantId,
    Note: "Lock mechanism still works, validation layer would reject in production",
    "Expected Outcome": `${config.expectedSuccesses} success, ${config.expectedConflicts} conflicts (lock-level)`,
  });

  const startTime = Date.now();
  const results = await executeConcurrentBookings(
    pastSlot,
    consultantId,
    config.concurrentUsers,
  );
  const duration = Date.now() - startTime;

  const report = generateTestReport(config, results, duration);
  logTestResult(report);

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  await saveJsonReport(
    report,
    `04-validation-scenarios/test-past-slot-booking-${timestamp}.json`,
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
    `test-past-slot-booking-${timestamp}.md`,
  );

  process.exit(report.passed ? 0 : 1);
}

runTest().catch((error) => {
  console.error("\n❌ Test execution failed:");
  console.error(error);
  process.exit(1);
});
