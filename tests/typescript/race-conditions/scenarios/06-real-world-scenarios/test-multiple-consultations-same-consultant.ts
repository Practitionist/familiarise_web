/**
 * Test: Multiple Consultations with Same Consultant
 * Category: 06 - Real-world Scenarios
 *
 * Scenario: Same user trying to book multiple slots with same consultant
 * Expected: All bookings should succeed (different slots)
 *
 * This test simulates a user booking multiple sessions.
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
    testName: "Multiple Consultations with Same Consultant",
    category: "06-real-world-scenarios",
    concurrentUsers: 4,
    slotTime: "multiple",
    consultantId: "",
    expectedSuccesses: 4,
    expectedConflicts: 0,
    expectedErrors: 0,
  };

  const consultantId = generateConsultantId();
  const userId = generateUserId(1); // Same user

  const slot1 = generateTestSlot(7, 10, 0);
  const slot2 = generateTestSlot(7, 11, 0);
  const slot3 = generateTestSlot(7, 14, 0);
  const slot4 = generateTestSlot(7, 15, 0);

  config.consultantId = consultantId;

  logTestStart(config.testName, {
    Category: config.category,
    "Scenario": "User booking multiple sessions with same consultant",
    "User ID": userId,
    "Slots": "4 different time slots",
    "Times": `${new Date(slot1.start).toLocaleTimeString()}, ${new Date(slot2.start).toLocaleTimeString()}, ${new Date(slot3.start).toLocaleTimeString()}, ${new Date(slot4.start).toLocaleTimeString()}`,
    "Consultant ID": consultantId,
    "Expected Outcome": `${config.expectedSuccesses} successes (all slots available)`,
  });

  const startTime = Date.now();

  const results: BookingResult[] = await Promise.all([
    simulateBookingAttempt(slot1.start, consultantId, userId),
    simulateBookingAttempt(slot2.start, consultantId, userId),
    simulateBookingAttempt(slot3.start, consultantId, userId),
    simulateBookingAttempt(slot4.start, consultantId, userId),
  ]);

  const duration = Date.now() - startTime;

  const report = generateTestReport(config, results, duration);
  logTestResult(report);

  console.log(`\n📊 Multi-Consultation Booking:`);
  console.log(`   User: ${userId}`);
  console.log(`   Slots Booked: ${report.summary.successes}/4`);
  console.log(`   Consultant: ${consultantId}`);
  console.log(`   Total Booking Time: ${duration}ms`);

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  await saveJsonReport(
    report,
    `06-real-world-scenarios/test-multiple-consultations-same-consultant-${timestamp}.json`,
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
    `test-multiple-consultations-same-consultant-${timestamp}.md`,
  );

  process.exit(report.passed ? 0 : 1);
}

runTest().catch((error) => {
  console.error("\n❌ Test execution failed:");
  console.error(error);
  process.exit(1);
});
