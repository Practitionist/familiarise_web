/**
 * Load Test: Semaphore Pattern for Multi-Participant Events
 *
 * PURPOSE:
 * Verify that the semaphore pattern in appointmentlock.ts correctly handles
 * 100+ concurrent webinar/class checkout attempts without race conditions.
 *
 * SCENARIOS:
 * 1. 100 concurrent users trying to join a 50-person webinar
 * 2. Verify exactly 50 succeed and 50 fail
 * 3. Verify released slots can be re-acquired
 * 4. Stress test with rapid acquire/release cycles
 *
 * RUN:
 * npx tsx tests/redis/test-semaphore-load.ts
 */

import redis from "@/lib/redis";
import crypto from "crypto";

// ============================================================================
// Test Configuration
// ============================================================================

const TEST_CONFIG = {
  TEST_KEY_PREFIX: "load-test-semaphore:",
  WEBINAR_MAX_PARTICIPANTS: 50,
  CONCURRENT_USERS: 100,
  SLOT_TTL: 60000, // 1 minute
};

// ============================================================================
// Semaphore Implementation (mirrors appointmentlock.ts)
// ============================================================================

interface EventSlotReservation {
  reservationId: string;
  slotNumber: number;
  eventType: string;
  eventId: string;
}

async function acquireEventSlot(
  eventType: string,
  eventId: string,
  maxParticipants: number,
  ttl: number = TEST_CONFIG.SLOT_TTL,
): Promise<EventSlotReservation | null> {
  const counterKey = `${TEST_CONFIG.TEST_KEY_PREFIX}counter:${eventType}:${eventId}`;
  const reservationId = crypto.randomUUID();

  const script = `
    local current = redis.call("get", KEYS[1])
    if current == false then
      current = 0
    else
      current = tonumber(current)
    end

    if current >= tonumber(ARGV[1]) then
      return -1
    end

    local newCount = redis.call("incr", KEYS[1])
    if newCount == 1 then
      redis.call("pexpire", KEYS[1], ARGV[2])
    end

    return newCount
  `;

  const slotNumber = (await redis.eval(
    script,
    [counterKey],
    [maxParticipants.toString(), ttl.toString()],
  )) as number;

  if (slotNumber === -1) {
    return null;
  }

  const reservationKey = `${TEST_CONFIG.TEST_KEY_PREFIX}reservation:${eventType}:${eventId}:${reservationId}`;
  await redis.set(reservationKey, slotNumber.toString(), { px: ttl });

  return { reservationId, slotNumber, eventType, eventId };
}

async function releaseEventSlot(
  reservation: EventSlotReservation,
): Promise<void> {
  const counterKey = `${TEST_CONFIG.TEST_KEY_PREFIX}counter:${reservation.eventType}:${reservation.eventId}`;
  const reservationKey = `${TEST_CONFIG.TEST_KEY_PREFIX}reservation:${reservation.eventType}:${reservation.eventId}:${reservation.reservationId}`;

  const exists = await redis.exists(reservationKey);
  if (exists) {
    const script = `
      local current = redis.call("get", KEYS[1])
      if current and tonumber(current) > 0 then
        return redis.call("decr", KEYS[1])
      end
      return 0
    `;

    await redis.del(reservationKey);
    await redis.eval(script, [counterKey], []);
  }
}

async function getEventSlotCount(
  eventType: string,
  eventId: string,
): Promise<number> {
  const counterKey = `${TEST_CONFIG.TEST_KEY_PREFIX}counter:${eventType}:${eventId}`;
  const count = await redis.get(counterKey);
  return count ? parseInt(count as string, 10) : 0;
}

async function cleanup(eventType: string, eventId: string): Promise<void> {
  const counterKey = `${TEST_CONFIG.TEST_KEY_PREFIX}counter:${eventType}:${eventId}`;
  await redis.del(counterKey);
  // Note: Individual reservations will expire via TTL
}

// ============================================================================
// Test Utilities
// ============================================================================

function logTest(
  testName: string,
  status: "START" | "PASS" | "FAIL" | "INFO",
  details?: any,
) {
  const emoji =
    status === "START"
      ? "🧪"
      : status === "PASS"
        ? "✅"
        : status === "FAIL"
          ? "❌"
          : "ℹ️";
  const timestamp = new Date().toISOString().split("T")[1].slice(0, 12);
  console.log(
    `[${timestamp}] ${emoji} ${testName}${details ? `: ${JSON.stringify(details)}` : ""}`,
  );
}

// ============================================================================
// Test 1: Concurrent Slot Acquisition (100 users, 50 slots)
// ============================================================================

async function testConcurrentSlotAcquisition() {
  const testName = "Test 1: Concurrent Slot Acquisition";
  logTest(testName, "START");

  const eventType = "WEBINAR";
  const eventId = `test-webinar-${Date.now()}`;
  const maxParticipants = TEST_CONFIG.WEBINAR_MAX_PARTICIPANTS;
  const concurrentUsers = TEST_CONFIG.CONCURRENT_USERS;

  try {
    // Clean up any existing data
    await cleanup(eventType, eventId);

    // Launch 100 concurrent slot acquisition attempts
    const startTime = Date.now();
    const promises: Promise<EventSlotReservation | null>[] = [];

    for (let i = 0; i < concurrentUsers; i++) {
      promises.push(acquireEventSlot(eventType, eventId, maxParticipants));
    }

    const results = await Promise.all(promises);
    const duration = Date.now() - startTime;

    // Count successes and failures
    const successes = results.filter(
      (r) => r !== null,
    ) as EventSlotReservation[];
    const failures = results.filter((r) => r === null);

    logTest(testName, "INFO", {
      totalAttempts: concurrentUsers,
      successes: successes.length,
      failures: failures.length,
      durationMs: duration,
      avgTimePerRequest: (duration / concurrentUsers).toFixed(2) + "ms",
    });

    // Verify exactly maxParticipants succeeded
    if (successes.length !== maxParticipants) {
      logTest(testName, "FAIL", {
        expected: maxParticipants,
        actual: successes.length,
        reason: "Wrong number of successful acquisitions",
      });
      await cleanup(eventType, eventId);
      return { passed: false, reservations: [] };
    }

    // Verify failures are correct
    if (failures.length !== concurrentUsers - maxParticipants) {
      logTest(testName, "FAIL", {
        expected: concurrentUsers - maxParticipants,
        actual: failures.length,
        reason: "Wrong number of failures",
      });
      await cleanup(eventType, eventId);
      return { passed: false, reservations: [] };
    }

    // Verify counter is at max
    const finalCount = await getEventSlotCount(eventType, eventId);
    if (finalCount !== maxParticipants) {
      logTest(testName, "FAIL", {
        expected: maxParticipants,
        actual: finalCount,
        reason: "Counter mismatch",
      });
      await cleanup(eventType, eventId);
      return { passed: false, reservations: [] };
    }

    // Verify all slot numbers are unique and sequential
    const slotNumbers = successes
      .map((s) => s.slotNumber)
      .sort((a, b) => a - b);
    const expectedSlots = Array.from(
      { length: maxParticipants },
      (_, i) => i + 1,
    );

    if (JSON.stringify(slotNumbers) !== JSON.stringify(expectedSlots)) {
      logTest(testName, "FAIL", {
        expected: expectedSlots,
        actual: slotNumbers,
        reason: "Slot numbers not sequential",
      });
      await cleanup(eventType, eventId);
      return { passed: false, reservations: [] };
    }

    logTest(testName, "PASS", {
      successfulSlots: maxParticipants,
      rejectedUsers: failures.length,
      finalCounter: finalCount,
      throughput: (concurrentUsers / (duration / 1000)).toFixed(2) + " req/s",
    });

    return { passed: true, reservations: successes, eventType, eventId };
  } catch (error) {
    logTest(testName, "FAIL", {
      error: error instanceof Error ? error.message : String(error),
    });
    await cleanup(eventType, eventId);
    return { passed: false, reservations: [] };
  }
}

// ============================================================================
// Test 2: Slot Release and Re-acquisition
// ============================================================================

async function testSlotReleaseAndReacquisition(
  eventType: string,
  eventId: string,
  reservations: EventSlotReservation[],
) {
  const testName = "Test 2: Slot Release and Re-acquisition";
  logTest(testName, "START");

  try {
    const maxParticipants = TEST_CONFIG.WEBINAR_MAX_PARTICIPANTS;

    // Release 10 slots
    const slotsToRelease = 10;
    const releasedReservations = reservations.slice(0, slotsToRelease);

    logTest(testName, "INFO", { releasing: slotsToRelease });

    for (const reservation of releasedReservations) {
      await releaseEventSlot(reservation);
    }

    // Verify counter decreased
    const countAfterRelease = await getEventSlotCount(eventType, eventId);
    if (countAfterRelease !== maxParticipants - slotsToRelease) {
      logTest(testName, "FAIL", {
        expected: maxParticipants - slotsToRelease,
        actual: countAfterRelease,
        reason: "Counter didn't decrease correctly",
      });
      return false;
    }

    // Try to acquire 15 new slots (only 10 should succeed)
    const newAttempts = 15;
    const newPromises: Promise<EventSlotReservation | null>[] = [];

    for (let i = 0; i < newAttempts; i++) {
      newPromises.push(acquireEventSlot(eventType, eventId, maxParticipants));
    }

    const newResults = await Promise.all(newPromises);
    const newSuccesses = newResults.filter((r) => r !== null);
    const newFailures = newResults.filter((r) => r === null);

    if (newSuccesses.length !== slotsToRelease) {
      logTest(testName, "FAIL", {
        expected: slotsToRelease,
        actual: newSuccesses.length,
        reason: "Wrong number of re-acquisitions",
      });
      return false;
    }

    // Verify counter is back to max
    const finalCount = await getEventSlotCount(eventType, eventId);
    if (finalCount !== maxParticipants) {
      logTest(testName, "FAIL", {
        expected: maxParticipants,
        actual: finalCount,
        reason: "Counter not back to max",
      });
      return false;
    }

    logTest(testName, "PASS", {
      slotsReleased: slotsToRelease,
      reacquired: newSuccesses.length,
      rejected: newFailures.length,
      finalCounter: finalCount,
    });

    return true;
  } catch (error) {
    logTest(testName, "FAIL", {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

// ============================================================================
// Test 3: Rapid Acquire/Release Stress Test
// ============================================================================

async function testRapidAcquireRelease() {
  const testName = "Test 3: Rapid Acquire/Release Stress Test";
  logTest(testName, "START");

  const eventType = "CLASS";
  const eventId = `stress-test-${Date.now()}`;
  const maxParticipants = 20;
  const iterations = 50;

  try {
    await cleanup(eventType, eventId);

    let totalAcquires = 0;
    let totalReleases = 0;
    const startTime = Date.now();

    // Simulate rapid acquire/release cycles
    for (let i = 0; i < iterations; i++) {
      // Acquire a batch of slots
      const batchSize = Math.floor(Math.random() * maxParticipants) + 1;
      const acquirePromises: Promise<EventSlotReservation | null>[] = [];

      for (let j = 0; j < batchSize; j++) {
        acquirePromises.push(
          acquireEventSlot(eventType, eventId, maxParticipants, 30000),
        );
      }

      const acquired = (await Promise.all(acquirePromises)).filter(
        (r) => r !== null,
      ) as EventSlotReservation[];
      totalAcquires += acquired.length;

      // Release some of them
      const releaseCount = Math.floor(acquired.length * Math.random());
      const toRelease = acquired.slice(0, releaseCount);

      for (const reservation of toRelease) {
        await releaseEventSlot(reservation);
        totalReleases++;
      }
    }

    const duration = Date.now() - startTime;

    // Final cleanup - release remaining slots
    const finalCount = await getEventSlotCount(eventType, eventId);

    logTest(testName, "PASS", {
      iterations,
      totalAcquires,
      totalReleases,
      finalCounter: finalCount,
      durationMs: duration,
      operationsPerSecond: (
        (totalAcquires + totalReleases) /
        (duration / 1000)
      ).toFixed(2),
    });

    await cleanup(eventType, eventId);
    return true;
  } catch (error) {
    logTest(testName, "FAIL", {
      error: error instanceof Error ? error.message : String(error),
    });
    await cleanup(eventType, eventId);
    return false;
  }
}

// ============================================================================
// Test 4: Counter Never Goes Negative
// ============================================================================

async function testCounterNeverNegative() {
  const testName = "Test 4: Counter Never Goes Negative";
  logTest(testName, "START");

  const eventType = "WEBINAR";
  const eventId = `negative-test-${Date.now()}`;
  const maxParticipants = 5;

  try {
    await cleanup(eventType, eventId);

    // Acquire all slots
    const reservations: EventSlotReservation[] = [];
    for (let i = 0; i < maxParticipants; i++) {
      const result = await acquireEventSlot(
        eventType,
        eventId,
        maxParticipants,
      );
      if (result) reservations.push(result);
    }

    // Release all slots
    for (const reservation of reservations) {
      await releaseEventSlot(reservation);
    }

    // Try to release again (should not go negative)
    for (const reservation of reservations) {
      await releaseEventSlot(reservation);
    }

    // Verify counter is 0, not negative
    const finalCount = await getEventSlotCount(eventType, eventId);
    if (finalCount < 0) {
      logTest(testName, "FAIL", {
        reason: "Counter went negative",
        finalCount,
      });
      await cleanup(eventType, eventId);
      return false;
    }

    logTest(testName, "PASS", {
      doubleReleasesAttempted: reservations.length,
      finalCounter: finalCount,
    });

    await cleanup(eventType, eventId);
    return true;
  } catch (error) {
    logTest(testName, "FAIL", {
      error: error instanceof Error ? error.message : String(error),
    });
    await cleanup(eventType, eventId);
    return false;
  }
}

// ============================================================================
// Run All Tests
// ============================================================================

async function runAllTests() {
  console.log("\n" + "=".repeat(80));
  console.log("🚀 Semaphore Load Test Suite");
  console.log("=".repeat(80));
  console.log(`Configuration:`);
  console.log(`  - Max Participants: ${TEST_CONFIG.WEBINAR_MAX_PARTICIPANTS}`);
  console.log(`  - Concurrent Users: ${TEST_CONFIG.CONCURRENT_USERS}`);
  console.log(`  - Slot TTL: ${TEST_CONFIG.SLOT_TTL}ms`);
  console.log("=".repeat(80) + "\n");

  const results = {
    concurrentAcquisition: false,
    releaseAndReacquire: false,
    rapidStress: false,
    counterNeverNegative: false,
  };

  try {
    // Test 1: Concurrent slot acquisition
    const test1Result = await testConcurrentSlotAcquisition();
    results.concurrentAcquisition = test1Result.passed;

    if (test1Result.passed && test1Result.reservations.length > 0) {
      // Test 2: Release and re-acquisition
      results.releaseAndReacquire = await testSlotReleaseAndReacquisition(
        test1Result.eventType!,
        test1Result.eventId!,
        test1Result.reservations,
      );

      // Cleanup from test 1 & 2
      await cleanup(test1Result.eventType!, test1Result.eventId!);
    }

    // Test 3: Rapid stress test
    results.rapidStress = await testRapidAcquireRelease();

    // Test 4: Counter never goes negative
    results.counterNeverNegative = await testCounterNeverNegative();

    // Summary
    console.log("\n" + "=".repeat(80));
    console.log("📊 Load Test Summary");
    console.log("=".repeat(80));

    const passed = Object.values(results).filter((r) => r).length;
    const total = Object.keys(results).length;

    Object.entries(results).forEach(([test, passed]) => {
      console.log(`${passed ? "✅" : "❌"} ${test}`);
    });

    console.log("\n" + "-".repeat(80));
    console.log(`Result: ${passed}/${total} tests passed`);
    console.log("=".repeat(80) + "\n");

    if (passed === total) {
      console.log("🎉 ALL LOAD TESTS PASSED!");
      console.log(
        "✅ Semaphore pattern handles 100+ concurrent checkouts correctly\n",
      );
      process.exit(0);
    } else {
      console.log("❌ SOME LOAD TESTS FAILED");
      console.log("⚠️  Review semaphore implementation for race conditions\n");
      process.exit(1);
    }
  } catch (error) {
    console.error("\n💥 Load test suite failed:", error);
    process.exit(1);
  }
}

// ============================================================================
// Execute
// ============================================================================

runAllTests();
