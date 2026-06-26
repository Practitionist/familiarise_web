/**
 * Upstash Redis Client
 *
 * This module provides:
 * - Redis client for distributed locking (used by appointmentlock.ts)
 * - Circuit breaker pattern to handle Redis failures gracefully
 * - Simple lock/unlock utilities
 *
 * NOTE: API rate limiting is handled by Arcjet at the route level.
 * This module focuses on Redis operations for distributed state management.
 *
 * Mock Mode:
 * - Set USE_MOCK_REDIS=true for local development without Upstash credentials
 * - Automatically enabled when NODE_ENV=test
 * - Mock provides in-memory Redis with full Lua script support
 */

import * as Sentry from "@sentry/nextjs";
import { Redis } from "@upstash/redis";
import crypto from "crypto";
import { getMockRedis, MockRedis } from "./redis-mock";

// Check if we should use mock Redis
const USE_MOCK_REDIS =
  process.env.USE_MOCK_REDIS === "true" || process.env.NODE_ENV === "test";

// Type that represents either real Redis or MockRedis
type RedisClient = Redis | MockRedis;

let redis: RedisClient;

if (USE_MOCK_REDIS) {
  // Use mock Redis for local dev and tests
  console.log(
    JSON.stringify({
      event: "redis_mock_enabled",
      reason:
        process.env.NODE_ENV === "test"
          ? "NODE_ENV=test"
          : "USE_MOCK_REDIS=true",
      timestamp: new Date().toISOString(),
    }),
  );
  redis = getMockRedis();
} else {
  // Validate environment variables for real Redis
  if (
    !process.env.UPSTASH_REDIS_REST_URL ||
    !process.env.UPSTASH_REDIS_REST_TOKEN
  ) {
    throw new Error(
      "UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN must be set (or use USE_MOCK_REDIS=true for local dev)",
    );
  }

  // Initialize real Upstash Redis client
  redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
  });
}

// ============================================================================
// Circuit Breaker Pattern
// Prevents cascading failures when Redis is unavailable
// ============================================================================

interface CircuitBreakerState {
  failures: number;
  lastFailure: number;
  state: "CLOSED" | "OPEN" | "HALF_OPEN";
  halfOpenSuccesses: number;
}

const circuitBreaker: CircuitBreakerState = {
  failures: 0,
  lastFailure: 0,
  state: "CLOSED",
  halfOpenSuccesses: 0,
};

const CIRCUIT_CONFIG = {
  failureThreshold: 5, // Open after 5 consecutive failures
  resetTimeout: 30000, // Try again after 30 seconds
  halfOpenSuccessThreshold: 3, // Close after 3 successful half-open requests
};

/**
 * Execute Redis operation with circuit breaker protection
 *
 * Circuit Breaker States:
 * - CLOSED: Normal operation, all requests go through
 * - OPEN: Redis is failing, fail fast without attempting
 * - HALF_OPEN: Testing if Redis is back, limited requests
 *
 * @param operation - The Redis operation to execute
 * @param fallback - Optional fallback value if circuit is open
 * @param shouldTrip - Optional predicate; when it returns false for a thrown
 *   error, that error is rethrown WITHOUT counting toward the breaker (an
 *   expected/application-level failure is not an outage). Defaults to "trip on
 *   any error".
 * @returns Result of operation or fallback
 */
export async function withCircuitBreaker<T>(
  operation: () => Promise<T>,
  fallback?: () => T,
  shouldTrip?: (error: unknown) => boolean,
): Promise<T> {
  // Check circuit state
  if (circuitBreaker.state === "OPEN") {
    const timeSinceFailure = Date.now() - circuitBreaker.lastFailure;

    if (timeSinceFailure > CIRCUIT_CONFIG.resetTimeout) {
      // Transition to HALF_OPEN for testing
      circuitBreaker.state = "HALF_OPEN";
      circuitBreaker.halfOpenSuccesses = 0;
      console.log(
        JSON.stringify({
          event: "circuit_breaker_half_open",
          timestamp: new Date().toISOString(),
        }),
      );
    } else {
      // Circuit is still open, fail fast
      console.warn(
        JSON.stringify({
          event: "circuit_breaker_rejected",
          remaining_ms: CIRCUIT_CONFIG.resetTimeout - timeSinceFailure,
          timestamp: new Date().toISOString(),
        }),
      );

      if (fallback) return fallback();
      throw new Error("Redis circuit breaker is OPEN - service unavailable");
    }
  }

  try {
    const result = await operation();

    // Success handling based on state
    if (circuitBreaker.state === "HALF_OPEN") {
      circuitBreaker.halfOpenSuccesses++;

      if (
        circuitBreaker.halfOpenSuccesses >=
        CIRCUIT_CONFIG.halfOpenSuccessThreshold
      ) {
        // Enough successes, close the circuit
        circuitBreaker.state = "CLOSED";
        circuitBreaker.failures = 0;
        circuitBreaker.halfOpenSuccesses = 0;
        console.log(
          JSON.stringify({
            event: "circuit_breaker_closed",
            reason: "successful_half_open_tests",
            timestamp: new Date().toISOString(),
          }),
        );
      }
    } else if (
      circuitBreaker.state === "CLOSED" &&
      circuitBreaker.failures > 0
    ) {
      // Reset failure count on success
      circuitBreaker.failures = 0;
    }

    return result;
  } catch (error) {
    // #899 — a caller-classified expected error (e.g. Stream "channel not
    // found") proves the backend is up; rethrow without touching breaker state
    // so 404-style misses don't dilute the outage signal and trip the shared
    // breaker for everyone.
    if (shouldTrip && !shouldTrip(error)) throw error;

    // Failure handling
    circuitBreaker.failures++;
    circuitBreaker.lastFailure = Date.now();

    if (circuitBreaker.state === "HALF_OPEN") {
      // Failed during half-open, back to open
      circuitBreaker.state = "OPEN";
      circuitBreaker.halfOpenSuccesses = 0;
      console.error(
        JSON.stringify({
          event: "circuit_breaker_reopened",
          reason: "half_open_failure",
          timestamp: new Date().toISOString(),
        }),
      );
    } else if (circuitBreaker.failures >= CIRCUIT_CONFIG.failureThreshold) {
      // Too many failures, open the circuit
      circuitBreaker.state = "OPEN";
      console.error(
        JSON.stringify({
          event: "circuit_breaker_opened",
          failures: circuitBreaker.failures,
          timestamp: new Date().toISOString(),
        }),
      );
      Sentry.logger.warn(Sentry.logger.fmt`redis circuit breaker: opened after ${circuitBreaker.failures} failures`);
    }

    if (fallback) return fallback();
    throw error;
  }
}

/**
 * Check Redis health (for monitoring and health endpoints)
 * @returns True if Redis is healthy, false otherwise
 */
export async function checkRedisHealth(): Promise<boolean> {
  try {
    const result = await redis.ping();
    return result === "PONG";
  } catch {
    return false;
  }
}

/**
 * Get circuit breaker status (for monitoring dashboards)
 * @returns Current circuit breaker state
 */
export function getCircuitBreakerStatus(): {
  state: string;
  failures: number;
  lastFailure: number | null;
} {
  return {
    state: circuitBreaker.state,
    failures: circuitBreaker.failures,
    lastFailure:
      circuitBreaker.lastFailure > 0 ? circuitBreaker.lastFailure : null,
  };
}

/**
 * Manually reset circuit breaker (for admin operations)
 */
export function resetCircuitBreaker(): void {
  circuitBreaker.state = "CLOSED";
  circuitBreaker.failures = 0;
  circuitBreaker.lastFailure = 0;
  circuitBreaker.halfOpenSuccesses = 0;
  console.log(
    JSON.stringify({
      event: "circuit_breaker_reset",
      reason: "manual_reset",
      timestamp: new Date().toISOString(),
    }),
  );
}

// ============================================================================
// Simple Lock/Unlock (for distributed locking)
// ============================================================================

/**
 * Acquire a simple lock with circuit breaker protection.
 *
 * When Redis is reachable: standard SET NX PX locking.
 * When Redis is unreachable / budget exhausted:
 *   - Circuit breaker trips after 5 consecutive failures
 *   - Returns null (= "lock not acquired") instead of crashing
 *   - Callers already handle null by telling the user to retry later
 *   - After 30 seconds, half-open probes test if Redis is back
 *
 * This means a Redis outage degrades to "temporarily cannot start
 * new payout batches / approval payments" rather than a 500 crash.
 *
 * @param key - The lock key
 * @param ttl - Time to live in milliseconds
 * @returns Lock token if acquired, null if locked or Redis unavailable
 */
export async function acquireLock(
  key: string,
  ttl: number,
): Promise<string | null> {
  return withCircuitBreaker(
    async () => {
      const token = crypto.randomUUID();
      const result = await redis.set(key, token, { nx: true, px: ttl });
      return result === "OK" ? token : null;
    },
    // Fallback when circuit is open: return null (= lock not acquired).
    // The caller's existing "try again later" message handles this gracefully.
    () => {
      console.warn(
        JSON.stringify({
          event: "lock_acquire_circuit_open",
          key,
          message:
            "Redis unavailable, returning null (lock not acquired). Caller will ask user to retry.",
          timestamp: new Date().toISOString(),
        }),
      );
      return null;
    },
  );
}

/**
 * Release a simple lock with circuit breaker protection.
 *
 * Uses atomic Lua script to check-and-delete, preventing release of
 * another client's lock. If Redis is unreachable, the lock will
 * expire naturally via its TTL — no data inconsistency, just a brief
 * period where the resource stays locked until TTL elapses.
 *
 * Never throws — safe for finally blocks.
 *
 * @param key - The lock key
 * @param token - The lock token (for safe release)
 */
export async function releaseLock(key: string, token: string): Promise<void> {
  try {
    await withCircuitBreaker(
      async () => {
        const script = `
          if redis.call("get", KEYS[1]) == ARGV[1] then
            return redis.call("del", KEYS[1])
          else
            return 0
          end
        `;
        await redis.eval(script, [key], [token]);
      },
      // Fallback: if Redis is down, the lock expires via TTL. Log and move on.
      () => {
        console.warn(
          JSON.stringify({
            event: "lock_release_circuit_open",
            key,
            message:
              "Redis unavailable, lock will expire via TTL. No action needed.",
            timestamp: new Date().toISOString(),
          }),
        );
      },
    );
  } catch (error) {
    // Never throw in release — log only. The lock's TTL is the safety net.
    console.error(
      JSON.stringify({
        event: "lock_release_error",
        key,
        error: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString(),
      }),
    );
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "redis" } });
  }
}

/**
 * Check if mock Redis is being used
 */
export function isMockRedis(): boolean {
  return USE_MOCK_REDIS;
}

/**
 * Reset mock Redis state (for testing)
 * No-op if using real Redis
 */
export function resetRedisForTesting(): void {
  if (USE_MOCK_REDIS && redis instanceof MockRedis) {
    redis.clear();
  }
}

export default redis;
