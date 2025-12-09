/**
 * Test: Throughput Testing
 * Category: 05 - Performance Scenarios
 *
 * Scenario: Measure system throughput - how many booking attempts can be processed
 * Expected: System maintains good throughput under load
 *
 * This test measures maximum throughput of the locking system.
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
    testName: "Throughput Testing",
    category: "05-performance-scenarios",
    concurrentUsers: 25,
    slotTime: "",
    consultantId: "",
    expectedSuccesses: 1,
    expectedConflicts: 24,
    expectedErrors: 0,
  };

  const slot = generateTestSlot(7, 15, 0);
  const consultantId = generateConsultantId();

  config.slotTime = slot.start;
  config.consultantId = consultantId;

  logTestStart(config.testName, {
    Category: config.category,
    Load: `${config.concurrentUsers} concurrent requests`,
    "Slot Time": new Date(slot.start).toLocaleString(),
    "Consultant ID": consultantId,
    Metric: "Requests processed per second",
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

  // Calculate throughput metrics
  const throughputPerSec = Math.round(
    (config.concurrentUsers / duration) * 1000,
  );
  const avgLatency = Math.round(duration / config.concurrentUsers);

  console.log(`\n📊 Throughput Metrics:`);
  console.log(`   Total Requests: ${config.concurrentUsers}`);
  console.log(`   Total Duration: ${duration}ms`);
  console.log(`   Throughput: ${throughputPerSec} requests/sec`);
  console.log(`   Avg Latency: ${avgLatency}ms per request`);
  console.log(`   P95 Latency: ${report.summary.p95Duration}ms`);
  console.log(`   P99 Latency: ${report.summary.p99Duration}ms`);
  console.log(
    `   Success Rate: ${((report.summary.successes / config.concurrentUsers) * 100).toFixed(1)}%`,
  );

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  await saveJsonReport(
    report,
    `05-performance-scenarios/test-throughput-${timestamp}.json`,
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
  await saveMarkdownReport(markdownContent, `test-throughput-${timestamp}.md`);

  process.exit(report.passed ? 0 : 1);
}

runTest().catch((error) => {
  console.error("\n❌ Test execution failed:");
  console.error(error);
  process.exit(1);
});
