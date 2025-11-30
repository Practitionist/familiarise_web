import { Redis } from "@upstash/redis";
import redisClient from "../lib/redis";
import crypto from "crypto";
import { SlotLockError } from "./errors/SlotLockError";

// ============================================================================
// Type Definitions
// ============================================================================

export interface ApprovalLock {
  key: string; // Redis key (e.g., "consultation-approval:clx123")
  value: string; // UUID for safe release verification
  ttl: number; // TTL in milliseconds (60000 = 60 seconds)
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

export interface EventSlotReservation {
  reservationId: string;
  slotNumber: number;
  eventType: string;
  eventId: string;
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

// FIX Issue #2: Increased default TTLs from 15-30s to 60s
// This prevents lock expiration during slow database operations
const DEFAULT_LOCK_TTL = 60000; // 60 seconds
const DEFAULT_EVENT_SLOT_TTL = 300000; // 5 minutes for payment completion

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
 * Release a distributed lock safely using atomic Lua script
 * Never throws - safe for finally blocks
 *
 * FIX Issue #3: Non-atomic lock release
 * Previous implementation used separate GET then DEL commands,
 * which could release another client's lock if TTL expired between operations.
 * Now uses atomic Lua script to check-and-delete in single operation.
 */
async function releaseLock(lock: ApprovalLock): Promise<void> {
  try {
    // Atomic release using Lua script
    // Only deletes if value matches (we still own the lock)
    const script = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      else
        return 0
      end
    `;

    const result = await lock.client.eval(
      script,
      [lock.key],
      [lock.value],
    );

    const heldDuration = Date.now() - lock.acquiredAt;

    if (result === 1) {
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
          reason: "value_mismatch_or_expired",
          held_duration_ms: heldDuration,
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

/**
 * Extend lock TTL (heartbeat pattern)
 * Call periodically during long operations to prevent expiration
 *
 * FIX Issue #2: Lock TTL Too Short
 * For long-running operations, this allows extending the lock
 * without releasing and re-acquiring (which could fail).
 */
export async function extendLock(
  lock: ApprovalLock,
  additionalTtl: number = 30000,
): Promise<boolean> {
  try {
    // Atomic extend using Lua script - only if we still own the lock
    const script = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("pexpire", KEYS[1], ARGV[2])
      else
        return 0
      end
    `;

    const result = await lock.client.eval(
      script,
      [lock.key],
      [lock.value, additionalTtl.toString()],
    );

    if (result === 1) {
      console.log(
        JSON.stringify({
          event: "lock_extended",
          key: lock.key,
          additional_ttl_ms: additionalTtl,
          timestamp: new Date().toISOString(),
        }),
      );
      return true;
    }

    console.warn(
      JSON.stringify({
        event: "lock_extension_failed",
        key: lock.key,
        reason: "lock_ownership_lost",
        timestamp: new Date().toISOString(),
      }),
    );
    return false;
  } catch (error: any) {
    console.error(
      JSON.stringify({
        event: "lock_extension_error",
        key: lock.key,
        error: error.message,
        timestamp: new Date().toISOString(),
      }),
    );
    return false;
  }
}

// ============================================================================
// Public API - Approval Payment Locks
// ============================================================================

/**
 * Lock a consultation approval to prevent concurrent approval attempts
 * @param consultationId - The consultation ID to lock
 * @param ttl - Time to live in milliseconds (default 60 seconds)
 * @returns Lock instance (must be released with unlockApproval)
 */
export async function lockConsultationApproval(
  consultationId: string,
  ttl: number = DEFAULT_LOCK_TTL,
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
 * @param ttl - Time to live in milliseconds (default 60 seconds)
 * @returns Lock instance (must be released with unlockApproval)
 */
export async function lockSubscriptionApproval(
  subscriptionId: string,
  ttl: number = DEFAULT_LOCK_TTL,
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
// Public API - Slot Booking Locks
// ============================================================================

/**
 * Lock a specific time slot to prevent double-booking during consultation creation
 * @param consultantProfileId - The consultant's profile ID
 * @param slotStartTimeInUTC - The slot start time in ISO format
 * @param ttl - Time to live in milliseconds (default 60 seconds)
 * @returns Lock instance (must be released with unlockSlotBooking)
 */
export async function lockSlotBooking(
  consultantProfileId: string,
  slotStartTimeInUTC: string,
  ttl: number = DEFAULT_LOCK_TTL,
): Promise<ApprovalLock> {
  const key = `slot-booking:${consultantProfileId}:${slotStartTimeInUTC}`;
  try {
    return await acquireLockWithRetry(key, ttl);
  } catch (error) {
    throw new SlotLockError(consultantProfileId, slotStartTimeInUTC, 60);
  }
}

/**
 * Release a slot booking lock
 * @param lock - The lock instance to release
 */
export async function unlockSlotBooking(lock: ApprovalLock): Promise<void> {
  await releaseLock(lock);
}

// ============================================================================
// Public API - Event Checkout Locks
// ============================================================================

/**
 * Lock event checkout to prevent concurrent booking attempts
 * Used for webinars, classes, and subscription scheduling periods
 * @param appointmentType - Type of appointment (WEBINAR, CLASS, SUBSCRIPTION)
 * @param eventOrPlanId - Event ID or plan ID to lock
 * @param ttl - Time to live in milliseconds (default 60 seconds)
 * @returns Lock instance (must be released with unlockEventCheckout)
 */
export async function lockEventCheckout(
  appointmentType: string,
  eventOrPlanId: string,
  ttl: number = DEFAULT_LOCK_TTL,
): Promise<ApprovalLock> {
  const key = `event-checkout:${appointmentType}:${eventOrPlanId}`;
  try {
    return await acquireLockWithRetry(key, ttl);
  } catch (error) {
    throw new Error(
      `Another user is currently checking out this ${appointmentType.toLowerCase()}. Please try again in a few seconds.`,
    );
  }
}

/**
 * Release an event checkout lock
 * @param lock - The lock instance to release
 */
export async function unlockEventCheckout(lock: ApprovalLock): Promise<void> {
  await releaseLock(lock);
}

// ============================================================================
// Public API - Event Slot Semaphore (for multi-participant events)
// FIX Issue #5: Event Lock Granularity Too Coarse
// ============================================================================

/**
 * Acquire a slot in a semaphore (for multi-participant events like webinars/classes)
 * This allows multiple concurrent checkouts up to maxParticipants limit.
 * Returns reservation ID if successful, null if event is full.
 *
 * @param eventType - Type of event (WEBINAR, CLASS)
 * @param eventId - Event ID
 * @param maxParticipants - Maximum number of concurrent reservations
 * @param ttl - Time to live in milliseconds (default 5 minutes for payment completion)
 * @returns Reservation info if successful, null if event is full
 */
export async function acquireEventSlot(
  eventType: string,
  eventId: string,
  maxParticipants: number,
  ttl: number = DEFAULT_EVENT_SLOT_TTL,
): Promise<EventSlotReservation | null> {
  const client = redisClient as Redis;
  const counterKey = `event-counter:${eventType}:${eventId}`;
  const reservationId = crypto.randomUUID();

  try {
    // Atomic increment with limit check using Lua script
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

    const slotNumber = await client.eval(
      script,
      [counterKey],
      [maxParticipants.toString(), ttl.toString()],
    ) as number;

    if (slotNumber === -1) {
      console.log(
        JSON.stringify({
          event: "event_slot_full",
          eventType,
          eventId,
          maxParticipants,
          timestamp: new Date().toISOString(),
        }),
      );
      return null;
    }

    // Store reservation for cleanup tracking
    const reservationKey = `event-reservation:${eventType}:${eventId}:${reservationId}`;
    await client.set(reservationKey, slotNumber.toString(), { px: ttl });

    console.log(
      JSON.stringify({
        event: "event_slot_acquired",
        eventType,
        eventId,
        slotNumber,
        reservationId,
        timestamp: new Date().toISOString(),
      }),
    );

    return { reservationId, slotNumber, eventType, eventId };
  } catch (error: any) {
    console.error(
      JSON.stringify({
        event: "event_slot_acquisition_error",
        eventType,
        eventId,
        error: error.message,
        timestamp: new Date().toISOString(),
      }),
    );
    throw error;
  }
}

/**
 * Release an event slot (on payment failure or cancellation)
 * Decrements the counter to allow another user to book.
 *
 * @param reservation - The reservation to release
 */
export async function releaseEventSlot(
  reservation: EventSlotReservation,
): Promise<void> {
  const client = redisClient as Redis;
  const counterKey = `event-counter:${reservation.eventType}:${reservation.eventId}`;
  const reservationKey = `event-reservation:${reservation.eventType}:${reservation.eventId}:${reservation.reservationId}`;

  try {
    // Check if reservation exists before decrementing
    const exists = await client.exists(reservationKey);
    if (exists) {
      // Atomic decrement (don't go below 0) using Lua script
      const script = `
        local current = redis.call("get", KEYS[1])
        if current and tonumber(current) > 0 then
          return redis.call("decr", KEYS[1])
        end
        return 0
      `;

      await client.del(reservationKey);
      await client.eval(script, [counterKey], []);

      console.log(
        JSON.stringify({
          event: "event_slot_released",
          eventType: reservation.eventType,
          eventId: reservation.eventId,
          reservationId: reservation.reservationId,
          timestamp: new Date().toISOString(),
        }),
      );
    } else {
      console.log(
        JSON.stringify({
          event: "event_slot_already_released",
          eventType: reservation.eventType,
          eventId: reservation.eventId,
          reservationId: reservation.reservationId,
          timestamp: new Date().toISOString(),
        }),
      );
    }
  } catch (error: any) {
    // Log but don't throw - cleanup should be best-effort
    console.error(
      JSON.stringify({
        event: "event_slot_release_error",
        eventType: reservation.eventType,
        eventId: reservation.eventId,
        reservationId: reservation.reservationId,
        error: error.message,
        timestamp: new Date().toISOString(),
      }),
    );
  }
}

/**
 * Confirm an event slot (on successful payment)
 * Removes reservation tracking but keeps counter (slot is now permanent in DB).
 *
 * @param reservation - The reservation to confirm
 */
export async function confirmEventSlot(
  reservation: EventSlotReservation,
): Promise<void> {
  const client = redisClient as Redis;
  const reservationKey = `event-reservation:${reservation.eventType}:${reservation.eventId}:${reservation.reservationId}`;

  try {
    // Just remove reservation tracking, counter stays (slot is confirmed in DB)
    await client.del(reservationKey);

    console.log(
      JSON.stringify({
        event: "event_slot_confirmed",
        eventType: reservation.eventType,
        eventId: reservation.eventId,
        reservationId: reservation.reservationId,
        timestamp: new Date().toISOString(),
      }),
    );
  } catch (error: any) {
    // Log but don't throw - confirmation should proceed
    console.error(
      JSON.stringify({
        event: "event_slot_confirmation_error",
        eventType: reservation.eventType,
        eventId: reservation.eventId,
        reservationId: reservation.reservationId,
        error: error.message,
        timestamp: new Date().toISOString(),
      }),
    );
  }
}

/**
 * Get current reservation count for an event
 * Useful for checking availability without reserving
 *
 * @param eventType - Type of event (WEBINAR, CLASS)
 * @param eventId - Event ID
 * @returns Current count of reservations
 */
export async function getEventSlotCount(
  eventType: string,
  eventId: string,
): Promise<number> {
  const client = redisClient as Redis;
  const counterKey = `event-counter:${eventType}:${eventId}`;

  try {
    const count = await client.get(counterKey);
    return count ? parseInt(count as string, 10) : 0;
  } catch (error: any) {
    console.error(
      JSON.stringify({
        event: "event_slot_count_error",
        eventType,
        eventId,
        error: error.message,
        timestamp: new Date().toISOString(),
      }),
    );
    return 0;
  }
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
