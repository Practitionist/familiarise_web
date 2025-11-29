import { Redis } from "@upstash/redis";
import redisClient from "../lib/redis";
import crypto from "crypto";

// ============================================================================
// Type Definitions
// ============================================================================

export interface ApprovalLock {
  key: string; // Redis key (e.g., "consultation-approval:clx123")
  value: string; // UUID for safe release verification
  ttl: number; // TTL in milliseconds (30000 = 30 seconds)
  acquiredAt: number; // Timestamp for monitoring
  client: Redis; // Client reference for release
}

export interface LockRetryConfig {
  retryCount: number; // Number of retry attempts (default: 10)
  retryDelay: number; // Base delay in ms (default: 200)
  retryJitter: number; // Random jitter in ms (default: 200)
  exponentialBackoff: boolean; // Use exponential backoff (default: true)
  driftFactor: number; // Clock drift factor (default: 0.01)
}

// ============================================================================
// Configuration
// ============================================================================

const DEFAULT_RETRY_CONFIG: LockRetryConfig = {
  retryCount: 10,
  retryDelay: 200,
  retryJitter: 200,
  exponentialBackoff: true,
  driftFactor: 0.01,
};

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Generate a unique lock value using UUID
 */
function generateLockValue(): string {
  return crypto.randomUUID();
}

/**
 * Calculate retry delay with exponential backoff and jitter
 */
function calculateRetryDelay(
  attempt: number,
  config: LockRetryConfig,
): number {
  const baseDelay = config.exponentialBackoff
    ? config.retryDelay * Math.pow(2, attempt)
    : config.retryDelay;
  const jitter = Math.random() * config.retryJitter;
  return baseDelay + jitter;
}

// ============================================================================
// Core Lock Operations
// ============================================================================

/**
 * Acquire a distributed lock with retry logic
 * Uses Upstash-compatible SET NX PX operation
 */
async function acquireLockWithRetry(
  key: string,
  ttl: number,
  config: LockRetryConfig = DEFAULT_RETRY_CONFIG,
): Promise<ApprovalLock> {
  const client = redisClient as Redis;
  const value = generateLockValue();
  const effectiveTTL = Math.floor(ttl * (1 - config.driftFactor));
  const startTime = Date.now();

  for (let attempt = 0; attempt <= config.retryCount; attempt++) {
    try {
      const result = await client.set(key, value, {
        nx: true, // Only set if not exists
        px: effectiveTTL, // TTL in milliseconds
      });

      if (result === "OK") {
        const duration = Date.now() - startTime;
        console.log(
          JSON.stringify({
            event: "lock_acquired",
            key,
            attempts: attempt + 1,
            duration_ms: duration,
            ttl: effectiveTTL,
            timestamp: new Date().toISOString(),
          }),
        );

        return {
          key,
          value,
          ttl: effectiveTTL,
          acquiredAt: Date.now(),
          client,
        };
      }

      // Lock already held, retry
      if (attempt < config.retryCount) {
        const delay = calculateRetryDelay(attempt, config);
        console.log(
          JSON.stringify({
            event: "lock_retry",
            key,
            attempt: attempt + 1,
            delay_ms: delay,
            timestamp: new Date().toISOString(),
          }),
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    } catch (error: any) {
      console.error(
        JSON.stringify({
          event: "lock_error",
          key,
          attempt: attempt + 1,
          error: error.message,
          timestamp: new Date().toISOString(),
        }),
      );

      if (attempt === config.retryCount) {
        throw error;
      }
    }
  }

  const totalDuration = Date.now() - startTime;
  throw new Error(
    `Failed to acquire lock after ${config.retryCount + 1} attempts (${totalDuration}ms)`,
  );
}

/**
 * Release a distributed lock safely
 * Never throws - safe for finally blocks
 */
async function releaseLock(lock: ApprovalLock): Promise<void> {
  try {
    const currentValue = await lock.client.get(lock.key);

    if (currentValue === lock.value) {
      await lock.client.del(lock.key);

      const heldDuration = Date.now() - lock.acquiredAt;
      console.log(
        JSON.stringify({
          event: "lock_released",
          key: lock.key,
          held_duration_ms: heldDuration,
          timestamp: new Date().toISOString(),
        }),
      );
    } else {
      console.log(
        JSON.stringify({
          event: "lock_already_released",
          key: lock.key,
          timestamp: new Date().toISOString(),
        }),
      );
    }
  } catch (error: any) {
    // Never throw in unlock - log only
    console.error(
      JSON.stringify({
        event: "lock_release_error",
        key: lock.key,
        error: error.message,
        timestamp: new Date().toISOString(),
      }),
    );
  }
}

// ============================================================================
// Public API - Approval Payment Locks
// ============================================================================

/**
 * Lock a consultation approval to prevent concurrent approval attempts
 * @param consultationId - The consultation ID to lock
 * @param ttl - Time to live in milliseconds (default 30 seconds)
 * @returns Lock instance (must be released with unlockApproval)
 */
export async function lockConsultationApproval(
  consultationId: string,
  ttl: number = 30000,
): Promise<ApprovalLock> {
  const key = `consultation-approval:${consultationId}`;
  try {
    return await acquireLockWithRetry(key, ttl);
  } catch (error) {
    throw new Error(
      "Another approval is in progress for this consultation. Please try again.",
    );
  }
}

/**
 * Lock a subscription approval to prevent concurrent approval attempts
 * @param subscriptionId - The subscription ID to lock
 * @param ttl - Time to live in milliseconds (default 30 seconds)
 * @returns Lock instance (must be released with unlockApproval)
 */
export async function lockSubscriptionApproval(
  subscriptionId: string,
  ttl: number = 30000,
): Promise<ApprovalLock> {
  const key = `subscription-approval:${subscriptionId}`;
  try {
    return await acquireLockWithRetry(key, ttl);
  } catch (error) {
    throw new Error(
      "Another approval is in progress for this subscription. Please try again.",
    );
  }
}

/**
 * Release an approval lock
 * @param lock - The lock instance to release
 */
export async function unlockApproval(lock: ApprovalLock): Promise<void> {
  await releaseLock(lock);
}

// ============================================================================
// Legacy Functions - Appointment Locks
// ============================================================================

/**
 * Lock an appointment
 * @param appointmentId - The appointment ID to lock
 * @param ttl - Time to live in milliseconds (default 5 minutes)
 * @returns Lock instance (must be released with unlockAppointment)
 */
export async function lockAppointment(
  appointmentId: string,
  ttl: number = 300000,
): Promise<ApprovalLock> {
  const key = `appointment-lock:${appointmentId}`;
  return await acquireLockWithRetry(key, ttl);
}

/**
 * Release an appointment lock
 * @param lock - The lock instance to release
 */
export async function unlockAppointment(lock: ApprovalLock): Promise<void> {
  await releaseLock(lock);
}

/**
 * Check if an appointment is locked
 * @param appointmentId - The appointment ID to check
 * @returns True if locked, false otherwise
 */
export async function isAppointmentLocked(
  appointmentId: string,
): Promise<boolean> {
  const client = redisClient as Redis;
  const key = `appointment-lock:${appointmentId}`;
  const exists = await client.exists(key);
  return exists === 1;
}
