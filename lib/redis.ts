/**
 * Upstash Redis client, per-service circuit breaker, and distributed lock helpers.
 */

import * as Sentry from "@sentry/nextjs";
import { Redis } from "@upstash/redis";
import crypto from "crypto";
import { getMockRedis, MockRedis } from "./redis-mock";

const USE_MOCK_REDIS =
  process.env.USE_MOCK_REDIS === "true" || process.env.NODE_ENV === "test";

type RedisClient = Redis | MockRedis;

let redis: RedisClient;

if (USE_MOCK_REDIS) {
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
  if (
    !process.env.UPSTASH_REDIS_REST_URL ||
    !process.env.UPSTASH_REDIS_REST_TOKEN
  ) {
    throw new Error(
      "UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN must be set (or use USE_MOCK_REDIS=true for local dev)",
    );
  }

  redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
  });
}

// ============================================================================
// Circuit Breaker Pattern
// ============================================================================

interface CircuitBreakerState {
  failures: number;
  totalRequests: number;
  lastFailure: number;
  state: "CLOSED" | "OPEN" | "HALF_OPEN";
  halfOpenSuccesses: number;
}

export interface CircuitBreakerOptions {
  failureThreshold?: number;
  resetTimeout?: number;
  halfOpenSuccessThreshold?: number;
  minRequests?: number;
}

const CIRCUIT_CONFIG = {
  failureThreshold: 5,
  resetTimeout: 30000,
  halfOpenSuccessThreshold: 3,
  minRequests: 20,
};

export interface CircuitBreaker {
  run<T>(
    operation: () => Promise<T>,
    fallback?: () => T,
    shouldTrip?: (error: unknown) => boolean,
  ): Promise<T>;
  status(): {
    name: string;
    state: string;
    failures: number;
    totalRequests?: number;
    lastFailure: number | null;
  };
  reset(): void;
}

/**
 * Create an isolated circuit breaker instance for a specific backing service.
 */
export function createCircuitBreaker(
  name: string,
  options: CircuitBreakerOptions = {},
): CircuitBreaker {
  const config = {
    failureThreshold:
      options.failureThreshold ?? CIRCUIT_CONFIG.failureThreshold,
    resetTimeout: options.resetTimeout ?? CIRCUIT_CONFIG.resetTimeout,
    halfOpenSuccessThreshold:
      options.halfOpenSuccessThreshold ??
      CIRCUIT_CONFIG.halfOpenSuccessThreshold,
    minRequests: options.minRequests ?? CIRCUIT_CONFIG.minRequests,
  };

  const circuitBreaker: CircuitBreakerState = {
    failures: 0,
    totalRequests: 0,
    lastFailure: 0,
    state: "CLOSED",
    halfOpenSuccesses: 0,
  };

  const log = (level: "log" | "warn" | "error", fields: object) => {
    console[level](
      JSON.stringify({
        breaker: name,
        timestamp: new Date().toISOString(),
        ...fields,
      }),
    );
  };

  function isRefusing(): boolean {
    if (circuitBreaker.state !== "OPEN") return false;

    const timeSinceFailure = Date.now() - circuitBreaker.lastFailure;
    if (timeSinceFailure > config.resetTimeout) {
      circuitBreaker.state = "HALF_OPEN";
      circuitBreaker.halfOpenSuccesses = 0;
      log("log", { event: "circuit_breaker_half_open" });
      return false;
    }

    log("warn", {
      event: "circuit_breaker_rejected",
      remaining_ms: config.resetTimeout - timeSinceFailure,
    });
    return true;
  }

  function recordSuccess(): void {
    circuitBreaker.totalRequests++;
    if (circuitBreaker.state === "HALF_OPEN") {
      circuitBreaker.halfOpenSuccesses++;
      if (circuitBreaker.halfOpenSuccesses >= config.halfOpenSuccessThreshold) {
        circuitBreaker.state = "CLOSED";
        circuitBreaker.failures = 0;
        circuitBreaker.halfOpenSuccesses = 0;
        log("log", {
          event: "circuit_breaker_closed",
          reason: "successful_half_open_tests",
        });
      }
      return;
    }
    if (circuitBreaker.state === "CLOSED" && circuitBreaker.failures > 0) {
      circuitBreaker.failures = 0;
    }
  }

  function recordFailure(): void {
    circuitBreaker.totalRequests++;
    circuitBreaker.failures++;
    circuitBreaker.lastFailure = Date.now();

    if (circuitBreaker.state === "HALF_OPEN") {
      circuitBreaker.state = "OPEN";
      circuitBreaker.halfOpenSuccesses = 0;
      log("error", {
        event: "circuit_breaker_reopened",
        reason: "half_open_failure",
      });
      return;
    }
    if (
      circuitBreaker.totalRequests >= config.minRequests &&
      circuitBreaker.failures >= config.failureThreshold
    ) {
      circuitBreaker.state = "OPEN";
      log("error", {
        event: "circuit_breaker_opened",
        failures: circuitBreaker.failures,
        totalRequests: circuitBreaker.totalRequests,
      });
      Sentry.logger.warn(
        Sentry.logger
          .fmt`${name} circuit breaker: opened after ${circuitBreaker.failures} failures (${circuitBreaker.totalRequests} total requests)`,
      );
    }
  }

  async function run<T>(
    operation: () => Promise<T>,
    fallback?: () => T,
    shouldTrip?: (error: unknown) => boolean,
  ): Promise<T> {
    if (isRefusing()) {
      if (fallback) return fallback();
      throw new Error(`${name} circuit breaker is OPEN - service unavailable`);
    }

    try {
      const result = await operation();
      recordSuccess();
      return result;
    } catch (error) {
      if (shouldTrip && !shouldTrip(error)) throw error;

      recordFailure();
      if (fallback) return fallback();
      throw error;
    }
  }

  function reset(): void {
    circuitBreaker.state = "CLOSED";
    circuitBreaker.failures = 0;
    circuitBreaker.totalRequests = 0;
    circuitBreaker.lastFailure = 0;
    circuitBreaker.halfOpenSuccesses = 0;
    console.log(
      JSON.stringify({
        event: "circuit_breaker_reset",
        breaker: name,
        reason: "manual_reset",
        timestamp: new Date().toISOString(),
      }),
    );
  }

  return {
    run,
    reset,
    status: () => ({
      name,
      state: circuitBreaker.state,
      failures: circuitBreaker.failures,
      totalRequests: circuitBreaker.totalRequests,
      lastFailure:
        circuitBreaker.lastFailure > 0 ? circuitBreaker.lastFailure : null,
    }),
  };
}

const redisCircuitBreaker = createCircuitBreaker("redis");

/**
 * Execute a Redis operation with circuit breaker protection.
 */
export async function withCircuitBreaker<T>(
  operation: () => Promise<T>,
  fallback?: () => T,
  shouldTrip?: (error: unknown) => boolean,
): Promise<T> {
  return redisCircuitBreaker.run(operation, fallback, shouldTrip);
}

const HEALTH_CACHE_MS = 2_000;
let healthCachedAt = 0;
let healthCachedValue = false;

export async function checkRedisHealth(force = false): Promise<boolean> {
  const now = Date.now();
  if (!force && now - healthCachedAt < HEALTH_CACHE_MS) {
    return healthCachedValue;
  }
  try {
    const result = await redis.ping();
    healthCachedValue = result === "PONG";
  } catch {
    healthCachedValue = false;
  }
  healthCachedAt = now;
  return healthCachedValue;
}

export function getCircuitBreakerStatus(): {
  state: string;
  failures: number;
  lastFailure: number | null;
} {
  const { state, failures, lastFailure } = redisCircuitBreaker.status();
  return { state, failures, lastFailure };
}

export function resetCircuitBreaker(): void {
  redisCircuitBreaker.reset();
}

// ============================================================================
// Distributed Lock Helpers & Shared Lua Scripts
// ============================================================================

import { RELEASE_LOCK_SCRIPT, RENEW_LOCK_SCRIPT } from "./redis-mock";
export { RELEASE_LOCK_SCRIPT, RENEW_LOCK_SCRIPT };

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

export function isRedisCircuitOpen(): boolean {
  return redisCircuitBreaker.status().state === "OPEN";
}

export async function releaseLock(key: string, token: string): Promise<void> {
  try {
    await withCircuitBreaker(
      async () => {
        await redis.eval(RELEASE_LOCK_SCRIPT, [key], [token]);
      },
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
    console.error(
      JSON.stringify({
        event: "lock_release_error",
        key,
        error: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString(),
      }),
    );
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "redis" } },
    );
  }
}

export async function renewLock(
  key: string,
  token: string,
  ttl: number,
): Promise<boolean> {
  try {
    return await withCircuitBreaker(
      async () => {
        const result = await redis.eval(
          RENEW_LOCK_SCRIPT,
          [key],
          [token, String(ttl)],
        );
        return result === 1;
      },
      () => false,
    );
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "lock_renew_error",
        key,
        error: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString(),
      }),
    );
    return false;
  }
}

export function isMockRedis(): boolean {
  return USE_MOCK_REDIS;
}

export function resetRedisForTesting(): void {
  if (USE_MOCK_REDIS && redis instanceof MockRedis) {
    redis.clear();
  }
}

export default redis;
