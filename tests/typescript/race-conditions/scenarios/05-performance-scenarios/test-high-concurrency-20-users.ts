/**
 * Test: High Concurrency (20 Users)
 * Category: 05 - Performance Scenarios
 *
 * Scenario: 20 users simultaneously attempt to book the same slot
 * Expected: 1 success, 19 conflicts, all handled gracefully
 *
 * This test validates system behavior under high concurrent load.
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
    testName: "High Concurrency (20 Users)",
    category: "05-performance-scenarios",
    concurrentUsers: 20,
    slotTime: "",
    consultantId: "",
    expectedSuccesses: 1,
    expectedConflicts: 19,
    expectedErrors: 0,
  };

  const slot = generateTestSlot(7, 14, 0);
  const consultantId = generateConsultantId();

  config.slotTime = slot.start;
  config.consultantId = consultantId;

  logTestStart(config.testName, {
    Category: config.category,
    "Concurrent Users": config.concurrentUsers,
    "Slot Time": new Date(slot.start).toLocaleString(),
    "Consultant ID": consultantId,
    "Performance Test": "High load scenario",
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

  console.log(`\n📊 Performance Metrics:`);
  console.log(`   Total Duration: ${duration}ms`);
  console.log(
    `   Avg Request Time: ${Math.round(duration / config.concurrentUsers)}ms`,
  );
  console.log(
    `   Throughput: ${Math.round((config.concurrentUsers / duration) * 1000)} requests/sec`,
  );

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  await saveJsonReport(
    report,
    `05-performance-scenarios/test-high-concurrency-20-users-${timestamp}.json`,
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
    `test-high-concurrency-20-users-${timestamp}.md`,
  );

  process.exit(report.passed ? 0 : 1);
}

runTest().catch((error) => {
  console.error("\n❌ Test execution failed:");
  console.error(error);
  process.exit(1);
});
