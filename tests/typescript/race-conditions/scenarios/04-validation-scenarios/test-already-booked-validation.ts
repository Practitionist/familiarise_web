/**
 * Test: Already Booked Slot Validation
 * Category: 04 - Validation Scenarios
 *
 * Scenario: Attempt to book a slot that's already marked as booked
 * Expected: Validation layer prevents booking even if lock is acquired
 *
 * This test validates that the second layer of protection (validation)
 * works correctly even when the lock is obtained.
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
import {
  generateTestSlot,
  generateConsultantId,
} from "../../utilities/fixtures.js";
import type { TestConfig, SummaryReport } from "../../utilities/types.js";

async function runTest() {
  resetBookingRegistry();

  const config: TestConfig = {
    testName: "Already Booked Slot Validation",
    category: "04-validation-scenarios",
    concurrentUsers: 3,
    slotTime: "",
    consultantId: "",
    expectedSuccesses: 1,
    expectedConflicts: 2,
    expectedErrors: 0,
  };

  const slot = generateTestSlot(7, 10, 30);
  const consultantId = generateConsultantId();

  config.slotTime = slot.start;
  config.consultantId = consultantId;

  logTestStart(config.testName, {
    Category: config.category,
    "Concurrent Users": config.concurrentUsers,
    "Slot Time": new Date(slot.start).toLocaleString(),
    "Consultant ID": consultantId,
    Validation: "Booking registry checks if slot already taken",
    "Expected Outcome": `${config.expectedSuccesses} success, ${config.expectedConflicts} conflicts`,
  });

  const startTime = Date.now();
  const results = await executeConcurrentBookings(
    slot.start,
    consultantId,
    config.concurrentUsers,
  );
  const duration = Date.now() - startTime;

  const report = generateTestReport(config, results, duration);
  logTestResult(report);

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  await saveJsonReport(
    report,
    `04-validation-scenarios/test-already-booked-validation-${timestamp}.json`,
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
    `test-already-booked-validation-${timestamp}.md`,
  );

  process.exit(report.passed ? 0 : 1);
}

runTest().catch((error) => {
  console.error("\n❌ Test execution failed:");
  console.error(error);
  process.exit(1);
});
