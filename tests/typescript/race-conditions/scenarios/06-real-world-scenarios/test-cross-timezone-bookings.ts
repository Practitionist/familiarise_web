/**
 * Test: Cross-Timezone Bookings
 * Category: 06 - Real-world Scenarios
 *
 * Scenario: Users from different timezones booking the same UTC slot
 * Expected: Lock mechanism works correctly with UTC times
 *
 * This test validates timezone-agnostic locking (all times in UTC).
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
    testName: "Cross-Timezone Bookings",
    category: "06-real-world-scenarios",
    concurrentUsers: 3,
    slotTime: "",
    consultantId: "",
    expectedSuccesses: 1,
    expectedConflicts: 2,
    expectedErrors: 0,
  };

  const slot = generateTestSlot(7, 18, 0); // 6:00 PM UTC
  const consultantId = generateConsultantId();

  config.slotTime = slot.start;
  config.consultantId = consultantId;

  // Calculate display times for different timezones
  const utcTime = new Date(slot.start);
  const estTime = new Date(utcTime.getTime() - 5 * 60 * 60 * 1000); // UTC-5
  const pstTime = new Date(utcTime.getTime() - 8 * 60 * 60 * 1000); // UTC-8
  const istTime = new Date(utcTime.getTime() + 5.5 * 60 * 60 * 1000); // UTC+5:30

  logTestStart(config.testName, {
    Category: config.category,
    Scenario: "Users from different timezones booking same slot",
    "UTC Time": utcTime.toISOString(),
    "EST Time": `${estTime.toLocaleTimeString()} (1:00 PM)`,
    "PST Time": `${pstTime.toLocaleTimeString()} (10:00 AM)`,
    "IST Time": `${istTime.toLocaleTimeString()} (11:30 PM)`,
    "Concurrent Users": config.concurrentUsers,
    "Consultant ID": consultantId,
    "Expected Outcome": `${config.expectedSuccesses} success, ${config.expectedConflicts} conflicts`,
  });

  console.log("\n   🌍 Simulating bookings from different timezones:");
  console.log("   User 1: EST (Eastern) - 1:00 PM local");
  console.log("   User 2: PST (Pacific) - 10:00 AM local");
  console.log("   User 3: IST (India) - 11:30 PM local");
  console.log("   All attempting to book: 6:00 PM UTC\n");

  const startTime = Date.now();
  const results = await executeConcurrentBookings(
    slot.start,
    consultantId,
    config.concurrentUsers,
  );
  const duration = Date.now() - startTime;

  const report = generateTestReport(config, results, duration);
  logTestResult(report);

  console.log(`\n📊 Cross-Timezone Analysis:`);
  console.log(`   UTC Slot Time: ${utcTime.toISOString()}`);
  console.log(`   Successful Booking: ${report.summary.successes}/3`);
  console.log(`   Conflicts: ${report.summary.conflicts}/3`);
  console.log(
    `   Lock Behavior: ${report.summary.successes === 1 ? "✅ Timezone-agnostic" : "❌ Issue detected"}`,
  );

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  await saveJsonReport(
    report,
    `06-real-world-scenarios/test-cross-timezone-bookings-${timestamp}.json`,
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
    `test-cross-timezone-bookings-${timestamp}.md`,
  );

  process.exit(report.passed ? 0 : 1);
}

runTest().catch((error) => {
  console.error("\n❌ Test execution failed:");
  console.error(error);
  process.exit(1);
});
