/**
 * Test: Weekend vs Weekday Booking Patterns
 * Category: 06 - Real-world Scenarios
 *
 * Scenario: Compare booking behavior on weekend vs weekday slots
 * Expected: Locking works consistently regardless of day
 *
 * This test validates day-agnostic locking behavior.
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
  generateConsultantId,
} from "../../utilities/fixtures.js";
import type { TestConfig, SummaryReport, BookingResult } from "../../utilities/types.js";

async function runTest() {
  resetBookingRegistry();

  const config: TestConfig = {
    testName: "Weekend vs Weekday Booking Patterns",
    category: "06-real-world-scenarios",
    concurrentUsers: 6, // 3 per slot type
    slotTime: "multiple",
    consultantId: "",
    expectedSuccesses: 2, // 1 weekday + 1 weekend
    expectedConflicts: 4, // 2 per slot
    expectedErrors: 0,
  };

  const consultantId = generateConsultantId();
  config.consultantId = consultantId;

  // Generate weekday slot (Monday)
  const weekday = new Date();
  weekday.setDate(weekday.getDate() + ((1 + 7 - weekday.getDay()) % 7 || 7)); // Next Monday
  weekday.setHours(14, 0, 0, 0);
  const weekdaySlot = weekday.toISOString();

  // Generate weekend slot (Saturday)
  const weekend = new Date();
  weekend.setDate(weekend.getDate() + ((6 + 7 - weekend.getDay()) % 7 || 7)); // Next Saturday
  weekend.setHours(14, 0, 0, 0);
  const weekendSlot = weekend.toISOString();

  logTestStart(config.testName, {
    Category: config.category,
    "Scenario": "Weekend vs Weekday booking comparison",
    "Weekday Slot": new Date(weekdaySlot).toLocaleString() + " (Monday)",
    "Weekend Slot": new Date(weekendSlot).toLocaleString() + " (Saturday)",
    "Users per Slot": 3,
    "Consultant ID": consultantId,
    "Expected Outcome": `2 successes (1 per slot type), 4 conflicts`,
  });

  const startTime = Date.now();

  const allResults: BookingResult[] = [];

  // Test weekday slot
  console.log("   📅 Testing weekday slot (Monday)...");
  const weekdayResults = await executeConcurrentBookings(weekdaySlot, consultantId, 3);
  allResults.push(...weekdayResults);

  // Test weekend slot
  console.log("   📅 Testing weekend slot (Saturday)...");
  const weekendResults = await executeConcurrentBookings(weekendSlot, consultantId, 3);
  allResults.push(...weekendResults);

  const duration = Date.now() - startTime;

  const report = generateTestReport(config, allResults, duration);
  logTestResult(report);

  console.log(`\n📊 Weekend vs Weekday Analysis:`);
  console.log(`   Weekday (Monday): ${weekdayResults.filter(r => r.status === 201).length} success, ${weekdayResults.filter(r => r.status === 409).length} conflicts`);
  console.log(`   Weekend (Saturday): ${weekendResults.filter(r => r.status === 201).length} success, ${weekendResults.filter(r => r.status === 409).length} conflicts`);
  console.log(`   Behavior Consistent: ${weekdayResults.filter(r => r.status === 201).length === weekendResults.filter(r => r.status === 201).length ? "✅ Yes" : "❌ No"}`);

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  await saveJsonReport(
    report,
    `06-real-world-scenarios/test-weekend-vs-weekday-${timestamp}.json`,
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
    `test-weekend-vs-weekday-${timestamp}.md`,
  );

  process.exit(report.passed ? 0 : 1);
}

runTest().catch((error) => {
  console.error("\n❌ Test execution failed:");
  console.error(error);
  process.exit(1);
});
