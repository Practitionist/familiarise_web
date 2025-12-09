/**
 * Test: Staggered Start Times
 * Category: 02 - Timing Scenarios
 *
 * Scenario: 3 users start booking requests with small delays between them
 * Expected: First user succeeds (201), others get conflicts (409)
 *
 * This test simulates near-simultaneous (but not perfectly concurrent)
 * booking attempts with realistic network latency variations.
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
import type {
  TestConfig,
  SummaryReport,
  BookingResult,
} from "../../utilities/types.js";

async function runTest() {
  resetBookingRegistry();

  const config: TestConfig = {
    testName: "Staggered Start Times",
    category: "02-timing-scenarios",
    concurrentUsers: 3,
    slotTime: "",
    consultantId: "",
    expectedSuccesses: 1,
    expectedConflicts: 2,
    expectedErrors: 0,
  };

  const slot = generateTestSlot(7, 11, 30); // 11:30 AM
  const consultantId = generateConsultantId();

  config.slotTime = slot.start;
  config.consultantId = consultantId;

  logTestStart(config.testName, {
    Category: config.category,
    "Staggered Users": config.concurrentUsers,
    "Slot Time": new Date(slot.start).toLocaleString(),
    "Consultant ID": consultantId,
    "Stagger Delay": "50ms between starts",
    "Expected Outcome": `${config.expectedSuccesses} success, ${config.expectedConflicts} conflicts`,
  });

  const startTime = Date.now();

  // Start requests with small delays (simulating network jitter)
  const promises: Promise<BookingResult>[] = [];

  // User 1: Start immediately
  promises.push(simulateBookingAttempt(slot.start, consultantId, generateUserId(1)));

  // User 2: Start after 50ms
  promises.push(
    new Promise<BookingResult>((resolve) => {
      setTimeout(async () => {
        resolve(await simulateBookingAttempt(slot.start, consultantId, generateUserId(2)));
      }, 50);
    })
  );

  // User 3: Start after 100ms
  promises.push(
    new Promise<BookingResult>((resolve) => {
      setTimeout(async () => {
        resolve(await simulateBookingAttempt(slot.start, consultantId, generateUserId(3)));
      }, 100);
    })
  );

  const results = await Promise.all(promises);
  const duration = Date.now() - startTime;

  const report = generateTestReport(config, results, duration);
  logTestResult(report);

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  await saveJsonReport(
    report,
    `02-timing-scenarios/test-staggered-start-times-${timestamp}.json`,
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
    `test-staggered-start-times-${timestamp}.md`,
  );

  process.exit(report.passed ? 0 : 1);
}

runTest().catch((error) => {
  console.error("\n❌ Test execution failed:");
  console.error(error);
  process.exit(1);
});
