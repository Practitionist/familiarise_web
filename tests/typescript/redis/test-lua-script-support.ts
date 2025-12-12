/**
 * Test: Upstash Redis Lua Script Support
 *
 * PURPOSE:
 * Verify that Upstash Redis REST API supports Lua scripts (EVAL command)
 * which are required for atomic lock release and semaphore operations in PR #233
 *
 * TESTS:
 * 1. Basic Lua script execution
 * 2. Atomic lock release script (check-and-delete)
 * 3. Semaphore counter script (atomic increment with limit)
 * 4. Lock extension script (atomic TTL update)
 *
 * RUN:
 * npx tsx tests/typescript/redis/test-lua-script-support.ts
 */

import redis from "@/lib/redis";
import crypto from "crypto";

// ============================================================================
// Test Configuration
// ============================================================================

const TEST_CONFIG = {
  TEST_KEY_PREFIX: "lua-test:",
  CLEANUP_DELAY: 1000, // 1 second delay between tests
};

// ============================================================================
// Test Utilities
// ============================================================================

async function cleanup(key: string) {
  await redis.del(key);
}

function logTest(
  testName: string,
  status: "START" | "PASS" | "FAIL",
  details?: any,
) {
  const emoji = status === "START" ? "🧪" : status === "PASS" ? "✅" : "❌";
  console.log(
    `${emoji} ${testName}${details ? `: ${JSON.stringify(details)}` : ""}`,
  );
}

// ============================================================================
// Test 1: Basic Lua Script Execution
// ============================================================================

async function testBasicLuaExecution() {
  const testName = "Test 1: Basic Lua Script Execution";
  logTest(testName, "START");

  try {
    // Simple Lua script that returns a string
    const script = `return "Hello from Lua!"`;

    const result = await redis.eval(script, [], []);

    if (result === "Hello from Lua!") {
      logTest(testName, "PASS", { result });
      return true;
    } else {
      logTest(testName, "FAIL", {
        expected: "Hello from Lua!",
        actual: result,
      });
      return false;
    }
  } catch (error) {
    logTest(testName, "FAIL", {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

// ============================================================================
// Test 2: Atomic Lock Release (Check-and-Delete)
// ============================================================================

async function testAtomicLockRelease() {
  const testName = "Test 2: Atomic Lock Release (Check-and-Delete)";
  logTest(testName, "START");

  const key = `${TEST_CONFIG.TEST_KEY_PREFIX}lock-release`;
  const correctValue = crypto.randomUUID();
  const wrongValue = crypto.randomUUID();

  try {
    // Setup: Set a lock
    await redis.set(key, correctValue, { px: 10000 });

    // Lua script for atomic check-and-delete (from PR #233)
    const script = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      else
        return 0
      end
    `;

    // Test 2a: Try to release with wrong value (should fail)
    const result1 = await redis.eval(script, [key], [wrongValue]);

    if (result1 !== 0) {
      logTest(testName, "FAIL", {
        test: "2a - wrong value should return 0",
        expected: 0,
        actual: result1,
      });
      await cleanup(key);
      return false;
    }

    // Verify key still exists
    const stillExists = await redis.exists(key);
    if (stillExists !== 1) {
      logTest(testName, "FAIL", {
        test: "2a - key should still exist",
        exists: stillExists,
      });
      await cleanup(key);
      return false;
    }

    // Test 2b: Try to release with correct value (should succeed)
    const result2 = await redis.eval(script, [key], [correctValue]);

    if (result2 !== 1) {
      logTest(testName, "FAIL", {
        test: "2b - correct value should return 1",
        expected: 1,
        actual: result2,
      });
      await cleanup(key);
      return false;
    }

    // Verify key is deleted
    const nowExists = await redis.exists(key);
    if (nowExists !== 0) {
      logTest(testName, "FAIL", {
        test: "2b - key should be deleted",
        exists: nowExists,
      });
      await cleanup(key);
      return false;
    }

    logTest(testName, "PASS", {
      wrongValueResult: result1,
      correctValueResult: result2,
    });
    return true;
  } catch (error) {
    logTest(testName, "FAIL", {
      error: error instanceof Error ? error.message : String(error),
    });
    await cleanup(key);
    return false;
  }
}

// ============================================================================
// Test 3: Semaphore Counter (Atomic Increment with Limit)
// ============================================================================

async function testSemaphoreCounter() {
  const testName = "Test 3: Semaphore Counter (Atomic Increment with Limit)";
  logTest(testName, "START");

  const key = `${TEST_CONFIG.TEST_KEY_PREFIX}semaphore-counter`;
  const maxLimit = 5;

  try {
    // Lua script for atomic increment with limit (from PR #233)
    const script = `
      local current = redis.call("get", KEYS[1])
      if current == false then
        current = 0
      else
        current = tonumber(current)
      end

      local max = tonumber(ARGV[1])

      if current >= max then
        return {0, current}
      end

      local new = current + 1
      redis.call("set", KEYS[1], new)
      redis.call("pexpire", KEYS[1], tonumber(ARGV[2]))

      return {1, new}
    `;

    const results = [];

    // Test 3a: Increment 5 times (should all succeed)
    for (let i = 0; i < maxLimit; i++) {
      const result = await redis.eval(
        script,
        [key],
        [maxLimit.toString(), "60000"],
      );
      results.push(result);

      // Result should be [1, i+1] meaning success with new count
      if (!Array.isArray(result) || result[0] !== 1 || result[1] !== i + 1) {
        logTest(testName, "FAIL", {
          test: `3a - increment ${i + 1} failed`,
          expected: [1, i + 1],
          actual: result,
        });
        await cleanup(key);
        return false;
      }
    }

    // Test 3b: Try to increment beyond limit (should fail)
    const overLimitResult = await redis.eval(
      script,
      [key],
      [maxLimit.toString(), "60000"],
    );

    if (
      !Array.isArray(overLimitResult) ||
      overLimitResult[0] !== 0 ||
      overLimitResult[1] !== maxLimit
    ) {
      logTest(testName, "FAIL", {
        test: "3b - over limit should return [0, 5]",
        expected: [0, maxLimit],
        actual: overLimitResult,
      });
      await cleanup(key);
      return false;
    }

    logTest(testName, "PASS", {
      successfulIncrements: maxLimit,
      overLimitResult,
    });
    await cleanup(key);
    return true;
  } catch (error) {
    logTest(testName, "FAIL", {
      error: error instanceof Error ? error.message : String(error),
    });
    await cleanup(key);
    return false;
  }
}

// ============================================================================
// Test 4: Lock Extension (Atomic TTL Update)
// ============================================================================

async function testLockExtension() {
  const testName = "Test 4: Lock Extension (Atomic TTL Update)";
  logTest(testName, "START");

  const key = `${TEST_CONFIG.TEST_KEY_PREFIX}lock-extension`;
  const correctValue = crypto.randomUUID();
  const wrongValue = crypto.randomUUID();

  try {
    // Setup: Set a lock with short TTL
    await redis.set(key, correctValue, { px: 5000 }); // 5 seconds

    // Lua script for atomic lock extension (from PR #233)
    const script = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        redis.call("pexpire", KEYS[1], tonumber(ARGV[2]))
        return 1
      else
        return 0
      end
    `;

    // Test 4a: Try to extend with wrong value (should fail)
    const result1 = await redis.eval(script, [key], [wrongValue, "30000"]);

    if (result1 !== 0) {
      logTest(testName, "FAIL", {
        test: "4a - wrong value should return 0",
        expected: 0,
        actual: result1,
      });
      await cleanup(key);
      return false;
    }

    // Test 4b: Try to extend with correct value (should succeed)
    const result2 = await redis.eval(script, [key], [correctValue, "30000"]);

    if (result2 !== 1) {
      logTest(testName, "FAIL", {
        test: "4b - correct value should return 1",
        expected: 1,
        actual: result2,
      });
      await cleanup(key);
      return false;
    }

    // Verify TTL was extended (should be close to 30000ms)
    const ttl = await redis.pttl(key);

    if (ttl < 25000 || ttl > 30000) {
      logTest(testName, "FAIL", {
        test: "4b - TTL should be ~30000ms",
        expected: "25000-30000",
        actual: ttl,
      });
      await cleanup(key);
      return false;
    }

    logTest(testName, "PASS", {
      wrongValueResult: result1,
      correctValueResult: result2,
      newTTL: ttl,
    });
    await cleanup(key);
    return true;
  } catch (error) {
    logTest(testName, "FAIL", {
      error: error instanceof Error ? error.message : String(error),
    });
    await cleanup(key);
    return false;
  }
}

// ============================================================================
// Test 5: Race Condition Simulation
// ============================================================================

async function testRaceConditionPrevention() {
  const testName = "Test 5: Race Condition Prevention (Lock Release)";
  logTest(testName, "START");

  const key = `${TEST_CONFIG.TEST_KEY_PREFIX}race-test`;
  const userAValue = "user-a-" + crypto.randomUUID();
  const userBValue = "user-b-" + crypto.randomUUID();

  try {
    // Simulate the race condition scenario from PR #233 documentation:
    // T=0ms    Client A: GET lock-key → returns "uuid-A" (matches)
    // T=1ms    Lock expires (TTL reached)
    // T=2ms    Client B: SET lock-key "uuid-B" NX → SUCCESS (acquires lock)
    // T=3ms    Client A: DEL lock-key → Should NOT delete B's lock!

    const releaseScript = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      else
        return 0
      end
    `;

    // Setup: User A acquires lock with very short TTL
    await redis.set(key, userAValue, { px: 100 }); // 100ms TTL

    // Simulate User A checking the lock
    const currentValue = await redis.get(key);

    // Wait for lock to expire
    await new Promise((resolve) => setTimeout(resolve, 150));

    // User B acquires the lock (should succeed since A's lock expired)
    const setBResult = await redis.set(key, userBValue, {
      nx: true,
      px: 10000,
    });

    if (setBResult !== "OK") {
      logTest(testName, "FAIL", {
        test: "User B should acquire expired lock",
        setBResult,
      });
      await cleanup(key);
      return false;
    }

    // User A tries to release using OLD value (should fail with Lua script)
    const releaseResult = await redis.eval(releaseScript, [key], [userAValue]);

    if (releaseResult !== 0) {
      logTest(testName, "FAIL", {
        test: "User A should NOT release User B's lock",
        expected: 0,
        actual: releaseResult,
      });
      await cleanup(key);
      return false;
    }

    // Verify User B's lock is still there
    const finalValue = await redis.get(key);

    if (finalValue !== userBValue) {
      logTest(testName, "FAIL", {
        test: "User B's lock should still exist",
        expected: userBValue,
        actual: finalValue,
      });
      await cleanup(key);
      return false;
    }

    logTest(testName, "PASS", {
      scenario: "User A cannot delete User B's lock",
      releaseResult,
      finalLockOwner: "User B",
    });
    await cleanup(key);
    return true;
  } catch (error) {
    logTest(testName, "FAIL", {
      error: error instanceof Error ? error.message : String(error),
    });
    await cleanup(key);
    return false;
  }
}

// ============================================================================
// Run All Tests
// ============================================================================

async function runAllTests() {
  console.log("\n" + "=".repeat(80));
  console.log("🧪 Upstash Redis Lua Script Support Test Suite");
  console.log("=".repeat(80) + "\n");

  const results = {
    basicExecution: false,
    atomicRelease: false,
    semaphoreCounter: false,
    lockExtension: false,
    raceCondition: false,
  };

  try {
    // Test 1: Basic Lua execution
    results.basicExecution = await testBasicLuaExecution();
    await new Promise((resolve) =>
      setTimeout(resolve, TEST_CONFIG.CLEANUP_DELAY),
    );

    // Test 2: Atomic lock release
    results.atomicRelease = await testAtomicLockRelease();
    await new Promise((resolve) =>
      setTimeout(resolve, TEST_CONFIG.CLEANUP_DELAY),
    );

    // Test 3: Semaphore counter
    results.semaphoreCounter = await testSemaphoreCounter();
    await new Promise((resolve) =>
      setTimeout(resolve, TEST_CONFIG.CLEANUP_DELAY),
    );

    // Test 4: Lock extension
    results.lockExtension = await testLockExtension();
    await new Promise((resolve) =>
      setTimeout(resolve, TEST_CONFIG.CLEANUP_DELAY),
    );

    // Test 5: Race condition prevention
    results.raceCondition = await testRaceConditionPrevention();

    // Summary
    console.log("\n" + "=".repeat(80));
    console.log("📊 Test Summary");
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
      console.log("🎉 ALL TESTS PASSED - Upstash Redis supports Lua scripts!");
      console.log(
        "✅ PR #233 can be safely merged (Lua script requirement met)\n",
      );
      process.exit(0);
    } else {
      console.log("❌ SOME TESTS FAILED - Review Lua script support");
      console.log(
        "⚠️  PR #233 may need modifications for Upstash compatibility\n",
      );
      process.exit(1);
    }
  } catch (error) {
    console.error("\n💥 Test suite failed:", error);
    process.exit(1);
  }
}

// ============================================================================
// Execute
// ============================================================================

runAllTests();
