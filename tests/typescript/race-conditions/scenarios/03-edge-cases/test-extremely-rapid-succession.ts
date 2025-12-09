/**
 * Test: Extremely Rapid Succession (Millisecond Gaps)
 * Category: 03 - Edge Cases
 *
 * Scenario: Users attempt bookings with <10ms gaps between requests
 * Expected: First user succeeds (201), others get conflicts (409)
 *
 * This test validates locking under extreme timing pressure where
 * requests arrive nearly instantaneously.
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
    testName: "Extremely Rapid Succession (Millisecond Gaps)",
    category: "03-edge-cases",
    concurrentUsers: 5,
    slotTime: "",
    consultantId: "",
    expectedSuccesses: 1,
    expectedConflicts: 4,
    expectedErrors: 0,
  };

  const slot = generateTestSlot(7, 14, 30);
  const consultantId = generateConsultantId();

  config.slotTime = slot.start;
  config.consultantId = consultantId;

  logTestStart(config.testName, {
    Category: config.category,
    "Rapid Users": config.concurrentUsers,
    "Slot Time": new Date(slot.start).toLocaleString(),
    "Consultant ID": consultantId,
    Timing: "<10ms gaps between requests",
    "Expected Outcome": `${config.expectedSuccesses} success, ${config.expectedConflicts} conflicts`,
  });

  const startTime = Date.now();

  // Launch requests with tiny delays (1-5ms)
  const promises: Promise<BookingResult>[] = [];

  for (let i = 1; i <= config.concurrentUsers; i++) {
    const delay = i * 2; // 2ms, 4ms, 6ms, 8ms, 10ms
    promises.push(
      new Promise<BookingResult>((resolve) => {
        setTimeout(async () => {
          resolve(
            await simulateBookingAttempt(
              slot.start,
              consultantId,
              generateUserId(i),
            ),
          );
        }, delay);
      }),
    );
  }

  const results = await Promise.all(promises);
  const duration = Date.now() - startTime;

  const report = generateTestReport(config, results, duration);
  logTestResult(report);

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  await saveJsonReport(
    report,
    `03-edge-cases/test-extremely-rapid-succession-${timestamp}.json`,
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
    `test-extremely-rapid-succession-${timestamp}.md`,
  );

  process.exit(report.passed ? 0 : 1);
}

runTest().catch((error) => {
  console.error("\n❌ Test execution failed:");
  console.error(error);
  process.exit(1);
});
