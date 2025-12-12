/**
 * Test: Mixed Success and Conflict Patterns
 * Category: 03 - Edge Cases
 *
 * Scenario: Multiple users booking multiple different slots simultaneously
 * Expected: Each slot gets 1 success, others get conflicts
 *
 * This test validates that the locking mechanism correctly handles
 * complex scenarios with mixed outcomes across different slots.
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
    testName: "Mixed Success and Conflict Patterns",
    category: "03-edge-cases",
    concurrentUsers: 6,
    slotTime: "multiple",
    consultantId: "",
    expectedSuccesses: 3, // One per slot
    expectedConflicts: 3, // One conflict per slot
    expectedErrors: 0,
  };

  const slot1 = generateTestSlot(7, 10, 0); // 10:00 AM
  const slot2 = generateTestSlot(7, 11, 0); // 11:00 AM
  const slot3 = generateTestSlot(7, 12, 0); // 12:00 PM
  const consultantId = generateConsultantId();

  config.consultantId = consultantId;

  logTestStart(config.testName, {
    Category: config.category,
    "Concurrent Users": config.concurrentUsers,
    Slots: "3 different slots (2 users each)",
    "Slot Times": `${new Date(slot1.start).toLocaleTimeString()}, ${new Date(slot2.start).toLocaleTimeString()}, ${new Date(slot3.start).toLocaleTimeString()}`,
    "Consultant ID": consultantId,
    "Expected Outcome": `${config.expectedSuccesses} successes (1 per slot), ${config.expectedConflicts} conflicts`,
  });

  const startTime = Date.now();

  // 6 users trying to book 3 slots (2 users per slot)
  const results: BookingResult[] = await Promise.all([
    simulateBookingAttempt(slot1.start, consultantId, generateUserId(1)), // Slot 1, User 1
    simulateBookingAttempt(slot1.start, consultantId, generateUserId(2)), // Slot 1, User 2
    simulateBookingAttempt(slot2.start, consultantId, generateUserId(3)), // Slot 2, User 3
    simulateBookingAttempt(slot2.start, consultantId, generateUserId(4)), // Slot 2, User 4
    simulateBookingAttempt(slot3.start, consultantId, generateUserId(5)), // Slot 3, User 5
    simulateBookingAttempt(slot3.start, consultantId, generateUserId(6)), // Slot 3, User 6
  ]);

  const duration = Date.now() - startTime;

  const report = generateTestReport(config, results, duration);
  logTestResult(report);

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  await saveJsonReport(
    report,
    `03-edge-cases/test-mixed-success-conflict-${timestamp}.json`,
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
    `test-mixed-success-conflict-${timestamp}.md`,
  );

  process.exit(report.passed ? 0 : 1);
}

runTest().catch((error) => {
  console.error("\n❌ Test execution failed:");
  console.error(error);
  process.exit(1);
});
