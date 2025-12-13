/**
 * Test: Peak Hours Booking
 * Category: 06 - Real-world Scenarios
 *
 * Scenario: High demand during peak hours (9-11 AM), multiple users competing
 * Expected: System handles peak load gracefully
 *
 * This test simulates real-world peak booking hours.
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
    testName: "Peak Hours Booking",
    category: "06-real-world-scenarios",
    concurrentUsers: 8,
    slotTime: "",
    consultantId: "",
    expectedSuccesses: 1,
    expectedConflicts: 7,
    expectedErrors: 0,
  };

  const slot = generateTestSlot(7, 9, 30); // 9:30 AM - peak hour
  const consultantId = generateConsultantId();

  config.slotTime = slot.start;
  config.consultantId = consultantId;

  logTestStart(config.testName, {
    Category: config.category,
    Scenario: "Peak hours (9-11 AM) - high demand",
    "Concurrent Users": config.concurrentUsers,
    "Slot Time": new Date(slot.start).toLocaleString() + " (PEAK HOUR)",
    "Consultant ID": consultantId,
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

  console.log(`\n📊 Peak Hours Performance:`);
  console.log(`   Peak Concurrent Users: ${config.concurrentUsers}`);
  console.log(
    `   Handled Successfully: ${report.summary.successes}/${config.concurrentUsers}`,
  );
  console.log(`   Conflict Responses: ${report.summary.conflicts}`);
  console.log(`   Avg Response Time: ${report.summary.averageDuration}ms`);

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  await saveJsonReport(
    report,
    `06-real-world-scenarios/test-peak-hours-booking-${timestamp}.json`,
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
    `test-peak-hours-booking-${timestamp}.md`,
  );

  process.exit(report.passed ? 0 : 1);
}

runTest().catch((error) => {
  console.error("\n❌ Test execution failed:");
  console.error(error);
  process.exit(1);
});
