/**
 * Test: Lock Contention
 * Category: 05 - Performance Scenarios
 *
 * Scenario: Multiple users competing for locks across different slots simultaneously
 * Expected: Good throughput despite contention
 *
 * This test validates lock performance under high contention.
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
import {
  generateTestSlot,
  generateConsultantId,
  generateUserId,
} from "../../utilities/fixtures.js";
import type { TestConfig, SummaryReport, BookingResult } from "../../utilities/types.js";

async function runTest() {
  resetBookingRegistry();

  const config: TestConfig = {
    testName: "Lock Contention",
    category: "05-performance-scenarios",
    concurrentUsers: 10,
    slotTime: "multiple",
    consultantId: "",
    expectedSuccesses: 5, // 1 per slot
    expectedConflicts: 5, // 1 per slot
    expectedErrors: 0,
  };

  const consultantId = generateConsultantId();
  config.consultantId = consultantId;

  // 5 different slots, 2 users each
  const slots = [
    generateTestSlot(7, 9, 0),
    generateTestSlot(7, 10, 0),
    generateTestSlot(7, 11, 0),
    generateTestSlot(7, 12, 0),
    generateTestSlot(7, 13, 0),
  ];

  logTestStart(config.testName, {
    Category: config.category,
    "Concurrent Users": config.concurrentUsers,
    "Slots": `${slots.length} different slots`,
    "Contention": "2 users per slot",
    "Consultant ID": consultantId,
    "Expected Outcome": `${config.expectedSuccesses} successes, ${config.expectedConflicts} conflicts`,
  });

  const startTime = Date.now();

  // Create all 10 requests (2 per slot) and execute concurrently
  const promises: Promise<BookingResult>[] = [];

  slots.forEach((slot, slotIndex) => {
    promises.push(simulateBookingAttempt(slot.start, consultantId, generateUserId(slotIndex * 2 + 1)));
    promises.push(simulateBookingAttempt(slot.start, consultantId, generateUserId(slotIndex * 2 + 2)));
  });

  const results = await Promise.all(promises);
  const duration = Date.now() - startTime;

  const report = generateTestReport(config, results, duration);
  logTestResult(report);

  console.log(`\n📊 Lock Contention Metrics:`);
  console.log(`   Total Duration: ${duration}ms`);
  console.log(`   Slots Tested: ${slots.length}`);
  console.log(`   Avg Time per Slot: ${Math.round(duration / slots.length)}ms`);
  console.log(`   Lock Conflicts: ${report.summary.conflicts}`);

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  await saveJsonReport(
    report,
    `05-performance-scenarios/test-lock-contention-${timestamp}.json`,
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
    `test-lock-contention-${timestamp}.md`,
  );

  process.exit(report.passed ? 0 : 1);
}

runTest().catch((error) => {
  console.error("\n❌ Test execution failed:");
  console.error(error);
  process.exit(1);
});
