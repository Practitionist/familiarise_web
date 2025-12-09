/**
 * Test: Original Bug Reproduction (Oct 28, 10:30 PM)
 * Category: 06 - Real-world Scenarios
 *
 * Scenario: Reproduce the exact bug from the screenshots
 * Users: Shubham Kumar and test_user both booking "28 Oct 10:30 PM"
 * Expected: With the fix, only ONE should succeed
 *
 * This test reproduces the original race condition bug to verify the fix works.
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
  generateOriginalBugSlot,
  generateConsultantId,
} from "../../utilities/fixtures.js";
import type { TestConfig, SummaryReport } from "../../utilities/types.js";

async function runTest() {
  resetBookingRegistry();

  const config: TestConfig = {
    testName: "Original Bug Reproduction (Oct 28, 10:30 PM)",
    category: "06-real-world-scenarios",
    concurrentUsers: 2,
    slotTime: "",
    consultantId: "",
    expectedSuccesses: 1,
    expectedConflicts: 1,
    expectedErrors: 0,
  };

  const slot = generateOriginalBugSlot(); // Oct 28, 10:30 PM
  const consultantId = generateConsultantId();

  config.slotTime = slot.start;
  config.consultantId = consultantId;

  logTestStart(config.testName, {
    Category: config.category,
    Scenario: "🐛 ORIGINAL BUG REPRODUCTION",
    Users: "Shubham Kumar and test_user (simulated)",
    "Slot Time": new Date(slot.start).toLocaleString(),
    "Consultant ID": consultantId,
    "Bug Description": "Both users got the same slot before the fix",
    "Expected with Fix": `${config.expectedSuccesses} success, ${config.expectedConflicts} conflicts`,
  });

  console.log("\n   📸 Reproducing scenario from screenshots...");
  console.log("   Before fix: Both users would get status 201");
  console.log("   After fix: Only one user should get status 201\n");

  const startTime = Date.now();
  const results = await executeConcurrentBookings(
    slot.start,
    consultantId,
    config.concurrentUsers,
  );
  const duration = Date.now() - startTime;

  const report = generateTestReport(config, results, duration);
  logTestResult(report);

  if (report.passed) {
    console.log("\n   ✅ BUG FIX VERIFIED!");
    console.log(
      "   The race condition that allowed double-booking has been fixed.",
    );
    console.log("   Only one user successfully booked the slot.");
  } else {
    console.log("\n   ⚠️  WARNING: Original bug may still exist!");
    console.log(
      "   Both users got success status - race condition not prevented.",
    );
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  await saveJsonReport(
    report,
    `06-real-world-scenarios/test-original-bug-reproduction-${timestamp}.json`,
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
    `test-original-bug-reproduction-${timestamp}.md`,
  );

  process.exit(report.passed ? 0 : 1);
}

runTest().catch((error) => {
  console.error("\n❌ Test execution failed:");
  console.error(error);
  process.exit(1);
});
