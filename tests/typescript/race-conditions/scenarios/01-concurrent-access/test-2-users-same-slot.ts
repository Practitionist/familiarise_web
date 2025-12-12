/**
 * Test: 2 Users Competing for Same Slot
 * Category: 01 - Concurrent Access Patterns
 *
 * Scenario: Two users attempt to book the exact same consultation slot simultaneously
 * Expected: First user succeeds (201), second user gets conflict (409)
 *
 * This test validates the basic distributed locking mechanism that prevents
 * race conditions when two users compete for the same time slot.
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
  // Reset booking registry to ensure clean state
  resetBookingRegistry();

  // Test Configuration
  const config: TestConfig = {
    testName: "2 Users Competing for Same Slot",
    category: "01-concurrent-access",
    concurrentUsers: 2,
    slotTime: "", // Will be set below
    consultantId: "", // Will be set below
    expectedSuccesses: 1,
    expectedConflicts: 1,
    expectedErrors: 0,
  };

  // Generate test data
  const slot = generateTestSlot(7, 10, 30); // 7 days ahead, 10:30 AM
  const consultantId = generateConsultantId();

  config.slotTime = slot.start;
  config.consultantId = consultantId;

  // Log test start
  logTestStart(config.testName, {
    Category: config.category,
    "Concurrent Users": config.concurrentUsers,
    "Slot Time": new Date(slot.start).toLocaleString(),
    "Consultant ID": consultantId,
    "Expected Outcome": `${config.expectedSuccesses} success, ${config.expectedConflicts} conflicts`,
  });

  // Execute test
  const startTime = Date.now();
  const results = await executeConcurrentBookings(
    slot.start,
    consultantId,
    config.concurrentUsers,
  );
  const duration = Date.now() - startTime;

  // Generate report
  const report = generateTestReport(config, results, duration);

  // Log results
  logTestResult(report);

  // Save reports
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  await saveJsonReport(
    report,
    `01-concurrent-access/test-2-users-same-slot-${timestamp}.json`,
  );

  // Generate and save markdown summary
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
    `test-2-users-same-slot-${timestamp}.md`,
  );

  // Exit with appropriate code
  process.exit(report.passed ? 0 : 1);
}

// Run the test
runTest().catch((error) => {
  console.error("\n❌ Test execution failed:");
  console.error(error);
  process.exit(1);
});
