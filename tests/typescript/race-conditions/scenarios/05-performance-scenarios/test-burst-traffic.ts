/**
 * Test: Burst Traffic Pattern
 * Category: 05 - Performance Scenarios
 *
 * Scenario: Sudden spike of 15 concurrent requests after period of low activity
 * Expected: 1 success, 14 conflicts, system handles burst gracefully
 *
 * This test simulates traffic spikes (e.g., after email notification sent).
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
    testName: "Burst Traffic Pattern",
    category: "05-performance-scenarios",
    concurrentUsers: 15,
    slotTime: "",
    consultantId: "",
    expectedSuccesses: 1,
    expectedConflicts: 14,
    expectedErrors: 0,
  };

  const slot = generateTestSlot(7, 16, 0);
  const consultantId = generateConsultantId();

  config.slotTime = slot.start;
  config.consultantId = consultantId;

  logTestStart(config.testName, {
    Category: config.category,
    "Burst Size": `${config.concurrentUsers} concurrent requests`,
    "Slot Time": new Date(slot.start).toLocaleString(),
    "Consultant ID": consultantId,
    Scenario: "Sudden traffic spike (e.g., email notification)",
    "Expected Outcome": `${config.expectedSuccesses} success, ${config.expectedConflicts} conflicts`,
  });

  // Simulate quiet period
  console.log("   ⏸️  Simulating quiet period (500ms)...");
  await new Promise((resolve) => setTimeout(resolve, 500));

  // Sudden burst
  console.log("   💥 Burst traffic starting...");
  const startTime = Date.now();
  const results = await executeConcurrentBookings(
    slot.start,
    consultantId,
    config.concurrentUsers,
  );
  const duration = Date.now() - startTime;

  const report = generateTestReport(config, results, duration);
  logTestResult(report);

  console.log(`\n📊 Burst Performance Metrics:`);
  console.log(`   Burst Duration: ${duration}ms`);
  console.log(`   Peak Load: ${config.concurrentUsers} concurrent requests`);
  console.log(
    `   Handled: ${report.summary.successes + report.summary.conflicts}/${config.concurrentUsers} requests`,
  );

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  await saveJsonReport(
    report,
    `05-performance-scenarios/test-burst-traffic-${timestamp}.json`,
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
    `test-burst-traffic-${timestamp}.md`,
  );

  process.exit(report.passed ? 0 : 1);
}

runTest().catch((error) => {
  console.error("\n❌ Test execution failed:");
  console.error(error);
  process.exit(1);
});
