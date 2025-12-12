/**
 * Test: Sustained Load
 * Category: 05 - Performance Scenarios
 *
 * Scenario: Multiple waves of concurrent requests over time
 * Expected: Each wave: 1 success, others conflict
 *
 * This test simulates sustained traffic over a period.
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
import type {
  TestConfig,
  SummaryReport,
  BookingResult,
} from "../../utilities/types.js";

async function runTest() {
  resetBookingRegistry();

  const config: TestConfig = {
    testName: "Sustained Load",
    category: "05-performance-scenarios",
    concurrentUsers: 12, // 3 waves of 4 users
    slotTime: "",
    consultantId: "",
    expectedSuccesses: 3, // 1 per wave
    expectedConflicts: 9, // 3 per wave
    expectedErrors: 0,
  };

  const consultantId = generateConsultantId();
  config.consultantId = consultantId;

  logTestStart(config.testName, {
    Category: config.category,
    "Load Pattern": "3 waves of 4 concurrent users",
    "Wave Interval": "200ms between waves",
    "Consultant ID": consultantId,
    "Expected Outcome": `${config.expectedSuccesses} successes (1 per wave), ${config.expectedConflicts} conflicts`,
  });

  const startTime = Date.now();
  const allResults: BookingResult[] = [];

  // Wave 1
  console.log("   🌊 Wave 1 starting...");
  const slot1 = generateTestSlot(7, 10, 0);
  const wave1 = await executeConcurrentBookings(slot1.start, consultantId, 4);
  allResults.push(...wave1);

  await new Promise((resolve) => setTimeout(resolve, 200));

  // Wave 2
  console.log("   🌊 Wave 2 starting...");
  const slot2 = generateTestSlot(7, 11, 0);
  const wave2 = await executeConcurrentBookings(slot2.start, consultantId, 4);
  allResults.push(...wave2);

  await new Promise((resolve) => setTimeout(resolve, 200));

  // Wave 3
  console.log("   🌊 Wave 3 starting...");
  const slot3 = generateTestSlot(7, 12, 0);
  const wave3 = await executeConcurrentBookings(slot3.start, consultantId, 4);
  allResults.push(...wave3);

  const duration = Date.now() - startTime;

  const report = generateTestReport(config, allResults, duration);
  logTestResult(report);

  console.log(`\n📊 Sustained Load Metrics:`);
  console.log(`   Total Duration: ${duration}ms`);
  console.log(`   Waves: 3`);
  console.log(`   Total Requests: ${allResults.length}`);
  console.log(
    `   Successful Waves: ${[wave1, wave2, wave3].filter((w) => w.some((r) => r.status === 201)).length}/3`,
  );

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  await saveJsonReport(
    report,
    `05-performance-scenarios/test-sustained-load-${timestamp}.json`,
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
    `test-sustained-load-${timestamp}.md`,
  );

  process.exit(report.passed ? 0 : 1);
}

runTest().catch((error) => {
  console.error("\n❌ Test execution failed:");
  console.error(error);
  process.exit(1);
});
