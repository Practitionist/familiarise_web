/**
 * Test script for MockRedis implementation
 * Run with: USE_MOCK_REDIS=true npx tsx tests/typescript/redis/test-mock-redis.ts
 */

import redis, { isMockRedis, resetRedisForTesting } from "@/lib/redis";

async function runTests() {
  console.log("=== MockRedis Tests ===\n");
  console.log("Using mock Redis:", isMockRedis());

  if (!isMockRedis()) {
    console.error("ERROR: Not using mock Redis! Set USE_MOCK_REDIS=true");
    process.exit(1);
  }

  let passed = 0;
  let failed = 0;

  // Test 1: Basic set/get
  try {
    await redis.set("test-key", "hello", { px: 5000 });
    const val = await redis.get("test-key");
    if (val === "hello") {
      console.log("✅ Test 1: Basic set/get - PASS");
      passed++;
    } else {
      console.log(`❌ Test 1: Basic set/get - FAIL (got: ${val})`);
      failed++;
    }
  } catch (e) {
    console.log(`❌ Test 1: Basic set/get - ERROR: ${e}`);
    failed++;
  }

  // Test 2: NX (only set if not exists)
  try {
    resetRedisForTesting();
    const nx1 = await redis.set("nx-key", "first", { nx: true });
    const nx2 = await redis.set("nx-key", "second", { nx: true });
    if (nx1 === "OK" && nx2 === null) {
      console.log("✅ Test 2: NX option - PASS");
      passed++;
    } else {
      console.log(`❌ Test 2: NX option - FAIL (nx1: ${nx1}, nx2: ${nx2})`);
      failed++;
    }
  } catch (e) {
    console.log(`❌ Test 2: NX option - ERROR: ${e}`);
    failed++;
  }

  // Test 3: Lua script - atomic lock release pattern
  try {
    resetRedisForTesting();
    await redis.set("lock-key", "my-token");
    const script = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      else
        return 0
      end
    `;
    const result = await redis.eval(script, ["lock-key"], ["my-token"]);
    const afterDel = await redis.get("lock-key");
    if (result === 1 && afterDel === null) {
      console.log("✅ Test 3: Lua script (lock release) - PASS");
      passed++;
    } else {
      console.log(
        `❌ Test 3: Lua script (lock release) - FAIL (result: ${result}, afterDel: ${afterDel})`,
      );
      failed++;
    }
  } catch (e) {
    console.log(`❌ Test 3: Lua script (lock release) - ERROR: ${e}`);
    failed++;
  }

  // Test 4: Lua script - wrong token should not release
  try {
    resetRedisForTesting();
    await redis.set("lock-key", "correct-token");
    const script = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      else
        return 0
      end
    `;
    const result = await redis.eval(script, ["lock-key"], ["wrong-token"]);
    const stillExists = await redis.get("lock-key");
    if (result === 0 && stillExists === "correct-token") {
      console.log("✅ Test 4: Lua script (wrong token) - PASS");
      passed++;
    } else {
      console.log(
        `❌ Test 4: Lua script (wrong token) - FAIL (result: ${result}, stillExists: ${stillExists})`,
      );
      failed++;
    }
  } catch (e) {
    console.log(`❌ Test 4: Lua script (wrong token) - ERROR: ${e}`);
    failed++;
  }

  // Test 5: Incr/Decr
  try {
    resetRedisForTesting();
    await redis.set("counter", "5");
    const inc = await redis.incr("counter");
    const dec = await redis.decr("counter");
    if (inc === 6 && dec === 5) {
      console.log("✅ Test 5: Incr/Decr - PASS");
      passed++;
    } else {
      console.log(`❌ Test 5: Incr/Decr - FAIL (inc: ${inc}, dec: ${dec})`);
      failed++;
    }
  } catch (e) {
    console.log(`❌ Test 5: Incr/Decr - ERROR: ${e}`);
    failed++;
  }

  // Test 6: Semaphore Lua script (from appointmentlock.ts)
  try {
    resetRedisForTesting();
    const maxParticipants = 3;
    const ttl = 60000;
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

    // First 3 should succeed
    const r1 = await redis.eval(
      script,
      ["event-counter"],
      [String(maxParticipants), String(ttl)],
    );
    const r2 = await redis.eval(
      script,
      ["event-counter"],
      [String(maxParticipants), String(ttl)],
    );
    const r3 = await redis.eval(
      script,
      ["event-counter"],
      [String(maxParticipants), String(ttl)],
    );
    // 4th should fail
    const r4 = await redis.eval(
      script,
      ["event-counter"],
      [String(maxParticipants), String(ttl)],
    );

    if (r1 === 1 && r2 === 2 && r3 === 3 && r4 === -1) {
      console.log("✅ Test 6: Semaphore Lua script - PASS");
      passed++;
    } else {
      console.log(
        `❌ Test 6: Semaphore Lua script - FAIL (r1: ${r1}, r2: ${r2}, r3: ${r3}, r4: ${r4})`,
      );
      failed++;
    }
  } catch (e) {
    console.log(`❌ Test 6: Semaphore Lua script - ERROR: ${e}`);
    failed++;
  }

  // Test 7: Lock extend Lua script
  try {
    resetRedisForTesting();
    await redis.set("extend-lock", "my-token", { px: 1000 });
    const script = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("pexpire", KEYS[1], ARGV[2])
      else
        return 0
      end
    `;
    const result = await redis.eval(
      script,
      ["extend-lock"],
      ["my-token", "30000"],
    );
    if (result === 1) {
      console.log("✅ Test 7: Lock extend Lua script - PASS");
      passed++;
    } else {
      console.log(
        `❌ Test 7: Lock extend Lua script - FAIL (result: ${result})`,
      );
      failed++;
    }
  } catch (e) {
    console.log(`❌ Test 7: Lock extend Lua script - ERROR: ${e}`);
    failed++;
  }

  // Test 8: exists
  try {
    resetRedisForTesting();
    await redis.set("exists-key", "value");
    const e1 = await redis.exists("exists-key");
    const e2 = await redis.exists("nonexistent");
    if (e1 === 1 && e2 === 0) {
      console.log("✅ Test 8: exists - PASS");
      passed++;
    } else {
      console.log(`❌ Test 8: exists - FAIL (e1: ${e1}, e2: ${e2})`);
      failed++;
    }
  } catch (e) {
    console.log(`❌ Test 8: exists - ERROR: ${e}`);
    failed++;
  }

  // Test 9: del
  try {
    resetRedisForTesting();
    await redis.set("del-key", "value");
    const d1 = await redis.del("del-key");
    const d2 = await redis.del("del-key");
    const afterDel = await redis.get("del-key");
    if (d1 === 1 && d2 === 0 && afterDel === null) {
      console.log("✅ Test 9: del - PASS");
      passed++;
    } else {
      console.log(
        `❌ Test 9: del - FAIL (d1: ${d1}, d2: ${d2}, afterDel: ${afterDel})`,
      );
      failed++;
    }
  } catch (e) {
    console.log(`❌ Test 9: del - ERROR: ${e}`);
    failed++;
  }

  // Test 10: ping
  try {
    const pong = await redis.ping();
    if (pong === "PONG") {
      console.log("✅ Test 10: ping - PASS");
      passed++;
    } else {
      console.log(`❌ Test 10: ping - FAIL (got: ${pong})`);
      failed++;
    }
  } catch (e) {
    console.log(`❌ Test 10: ping - ERROR: ${e}`);
    failed++;
  }

  // Summary
  console.log("\n=== Summary ===");
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);
  console.log(`Total: ${passed + failed}`);

  // Cleanup
  resetRedisForTesting();

  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch((e) => {
  console.error("Test runner failed:", e);
  process.exit(1);
});
