import { Redis } from "@upstash/redis";
import redisClient, { withCircuitBreaker, checkRedisHealth } from "../lib/redis";
import crypto from "crypto";
import { SlotLockError } from "./errors/SlotLockError";

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// CN-1 (#676) — retries exhausted because the lock is genuinely HELD (SET NX
// kept returning non-OK), as opposed to a thrown Redis error. Typed so callers
// can tell benign contention apart from an unreachable Redis and decide whether
// to fail open (retry-later) or closed (503). Subclasses Error, so existing
// catch-all callers are unaffected.
export class LockContentionError extends Error {
  constructor(
    readonly key: string,
    readonly attempts: number,
  ) {
    super(`Failed to acquire lock for ${key} after ${attempts} attempts`);
    this.name = "LockContentionError";
  }
}

// CN-1 (#676) — Redis is unreachable / the circuit is open, so NO real lock can
// be taken. The event-checkout path must fail CLOSED (reject) on this rather
// than proceed unlocked: without a lock, two concurrent buyers can both clear
// the same finite event capacity. Mirrors CronLockUnavailableError.
export class EventCheckoutLockUnavailableError extends Error {
  readonly httpStatus = 503 as const;
  readonly code = "EVENT_CHECKOUT_LOCK_UNAVAILABLE" as const;
  constructor(readonly appointmentType: string) {
    super(
      `Cannot secure a checkout lock for this ${appointmentType.toLowerCase()} right now (locking service unavailable). Please try again shortly.`,
    );
    this.name = "EventCheckoutLockUnavailableError";
  }
}

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

interface LockRetryConfig {
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

// FIX Issue #2: Increased default TTLs from 15-30s to 60s
// This prevents lock expiration during slow database operations
const DEFAULT_LOCK_TTL = 60000; // 60 seconds

// #832 — one 60s budget cannot cover every checkout shape: a class checkout
// writes N sessions × M slots plus a gateway round-trip and can outlive its
// lock, silently admitting a second buyer. Sized per checkout type (mirrors
// the LONG_JOB_TTL_MS precedent in lib/cron/with-cron-lock.ts); checkout
// also renews once before the gateway call and aborts if ownership is lost.
export const CHECKOUT_LOCK_TTL_MS: Record<string, number> = {
  CONSULTATION: 60_000,
  SUBSCRIPTION: 120_000,
  WEBINAR: 120_000,
  CLASS: 300_000,
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
function calculateRetryDelay(attempt: number, config: LockRetryConfig): number {
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
    } catch (error: unknown) {
      console.error(
        JSON.stringify({
          event: "lock_error",
          key,
          attempt: attempt + 1,
          error: getErrorMessage(error),
          timestamp: new Date().toISOString(),
        }),
      );

      if (attempt === config.retryCount) {
        throw error;
      }
    }
  }

  const totalDuration = Date.now() - startTime;
  // CN-1 — typed contention (lock was HELD, never a Redis error; those rethrow
  // above). The ms detail rides the log, not the message, so the class is clean.
  console.log(
    JSON.stringify({
      event: "lock_contention_exhausted",
      key,
      attempts: config.retryCount + 1,
      duration_ms: totalDuration,
      timestamp: new Date().toISOString(),
    }),
  );
  throw new LockContentionError(key, config.retryCount + 1);
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

    const result = await lock.client.eval(script, [lock.key], [lock.value]);

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
  } catch (error: unknown) {
    // Never throw in unlock - log only
    console.error(
      JSON.stringify({
        event: "lock_release_error",
        key: lock.key,
        error: getErrorMessage(error),
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
  } catch (error: unknown) {
    console.error(
      JSON.stringify({
        event: "lock_extension_error",
        key: lock.key,
        error: getErrorMessage(error),
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
      "Lock contention: Another approval is in progress for this consultation. Please try again.",
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
      "Lock contention: Another approval is in progress for this subscription. Please try again.",
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
 * @param startsAt - The slot start time in ISO format
 * @param ttl - Time to live in milliseconds (default 60 seconds)
 * @returns Lock instance (must be released with unlockSlotBooking)
 */
export async function lockSlotBooking(
  consultantProfileId: string,
  startsAt: string,
  ttl: number = DEFAULT_LOCK_TTL,
): Promise<ApprovalLock> {
  const key = `slot-booking:${consultantProfileId}:${startsAt}`;
  try {
    return await acquireLockWithRetry(key, ttl);
  } catch (error) {
    throw new SlotLockError(consultantProfileId, startsAt, 60);
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

  // CN-1 (#676) — was: catch ALL errors → benign contention message, which
  // failed OPEN (a Redis outage let the caller proceed UNLOCKED and double-book
  // an event's capacity). Now we fail CLOSED on an unreachable Redis. The probe
  // mirrors withCronLock's checkRedisHealth gate and closes the entry window.
  if (!(await checkRedisHealth())) {
    throw new EventCheckoutLockUnavailableError(appointmentType);
  }

  // Acquire through the circuit breaker (same breaker as lib/redis.ts /
  // lib/maintenance.ts) so a mid-flight outage trips it and fails closed too.
  // Genuine contention is returned as a sentinel — NOT thrown — so the breaker
  // doesn't count "lock held" as a Redis failure; only real I/O errors throw
  // inside the operation and feed the breaker.
  let lock: ApprovalLock | "CONTENTION";
  try {
    lock = await withCircuitBreaker<ApprovalLock | "CONTENTION">(async () => {
      try {
        return await acquireLockWithRetry(key, ttl);
      } catch (error) {
        if (error instanceof LockContentionError) return "CONTENTION";
        throw error; // Redis I/O error → propagate to the breaker
      }
    });
  } catch (error: unknown) {
    // Circuit open or Redis unreachable during acquisition → fail closed.
    // #873 — log the original cause so triage can tell a real Redis outage
    // from another fault before rethrowing the opaque typed error.
    console.error(
      JSON.stringify({
        event: "event_checkout_lock_unavailable",
        key,
        appointmentType,
        error: getErrorMessage(error),
        timestamp: new Date().toISOString(),
      }),
    );
    throw new EventCheckoutLockUnavailableError(appointmentType);
  }

  if (lock === "CONTENTION") {
    // Genuine contention — another buyer holds the lock. Fail OPEN (retry-later),
    // exactly as before; this is a benign, expected outcome, not an outage.
    throw new Error(
      `Another user is currently checking out this ${appointmentType.toLowerCase()}. Please try again in a few seconds.`,
    );
  }

  return lock;
}

/**
 * Release an event checkout lock
 * @param lock - The lock instance to release
 */
export async function unlockEventCheckout(lock: ApprovalLock): Promise<void> {
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

// ============================================================================
// Public API - Trial Slot Booking Locks
// ============================================================================

/**
 * Lock a specific time slot to prevent double-booking during trial scheduling
 * @param consultantProfileId - The consultant's profile ID
 * @param startsAt - The slot start time in ISO format
 * @param ttl - Time to live in milliseconds (default 60 seconds)
 * @returns Lock instance (must be released with unlockTrialSlot)
 */
export async function lockTrialSlot(
  consultantProfileId: string,
  startsAt: string,
  ttl: number = DEFAULT_LOCK_TTL,
): Promise<ApprovalLock> {
  const key = `trial-slot-booking:${consultantProfileId}:${startsAt}`;
  try {
    return await acquireLockWithRetry(key, ttl);
  } catch (error) {
    throw new SlotLockError(consultantProfileId, startsAt, 60);
  }
}

/**
 * Release a trial slot booking lock
 * @param lock - The lock instance to release
 */
export async function unlockTrialSlot(lock: ApprovalLock): Promise<void> {
  await releaseLock(lock);
}

// ============================================================================
// Public API - Auto-Allocation Locks
// FIX Issue #1 from Architecture Review (#446):
// autoAllocate() had NO distributed lock — double-booking via race condition
// ============================================================================

/**
 * Lock auto-allocation for a specific consultant to prevent concurrent
 * auto-allocations from double-booking the same slots.
 *
 * WHY CONSULTANT-LEVEL (not per-slot):
 * autoAllocate() discovers slots dynamically inside the transaction,
 * so per-slot locks can't be acquired upfront. Since auto-allocate
 * searches a consultant's ENTIRE availability pool, two concurrent
 * auto-allocations for the same consultant MUST be serialized.
 *
 * @param consultantProfileId - The consultant's profile ID
 * @param ttl - Time to live in milliseconds (default 120s to match transaction timeout)
 * @returns Lock instance (must be released with unlockAutoAllocate)
 */
export async function lockAutoAllocate(
  consultantProfileId: string,
  // #860 — optional day/slot-range scope. When the target day is known upfront
  // (manual allocation), sharding the key lets non-overlapping-day allocations
  // for one consultant run in parallel instead of all serializing. autoAllocate
  // omits it (slots are discovered dynamically UNDER the lock) and stays
  // consultant-wide. #440's GiST exclusion constraint is the correctness
  // backstop for any residual cross-day overlap.
  scope?: string,
  ttl: number = 150000, // 150s — 30s buffer over 120s transaction timeout (after 1% drift: ~148.5s)
): Promise<ApprovalLock> {
  const key = scope
    ? `auto-allocate:${consultantProfileId}:${scope}`
    : `auto-allocate:${consultantProfileId}`;
  try {
    return await acquireLockWithRetry(key, ttl);
  } catch (error) {
    throw new Error(
      "Lock contention: Another auto-allocation is in progress for this consultant. Please try again.",
    );
  }
}

/**
 * Release an auto-allocation lock
 * @param lock - The lock instance to release
 */
export async function unlockAutoAllocate(lock: ApprovalLock): Promise<void> {
  await releaseLock(lock);
}

// ============================================================================
// Public API - Consultee Booking Locks
// #898 follow-up — the GiST exclusion constraint `slot_no_confirmed_overlap`
// is keyed on consultantProfileId, so it CANNOT stop the SAME consultee being
// booked across two DIFFERENT consultants at overlapping times. The AE-1
// consultee-calendar conflict check (SlotValidationService.validateNoConflicts)
// runs at Read-Committed with no consultee lock, leaving a check-then-write
// window under concurrent checkout. This lock serializes booking activity for
// one consultee (different consultees stay fully parallel) so the
// consultee-conflict-check → slot write is atomic.
// ============================================================================

/**
 * Lock all booking activity for a single consultee so concurrent bookings
 * (across different consultants) cannot both pass the consultee-calendar
 * conflict check and overcommit the same person.
 *
 * Keyed on consulteeUserId ONLY — different consultees never contend.
 *
 * LOCK ORDER (deadlock avoidance): always acquired AFTER the consultant-level
 * lock (lockAutoAllocate / lockEventCheckout) and BEFORE any per-slot lock.
 * Every booking path follows the same consultant → consultee → slot order, so
 * the locks form a total order and cannot cycle.
 *
 * @param consulteeUserId - The consultee's user ID
 * @param ttl - Time to live in ms (default 150s — matches lockAutoAllocate so it
 *   spans the allocation transaction)
 */
export async function lockConsulteeBooking(
  consulteeUserId: string,
  ttl: number = 150000,
): Promise<ApprovalLock> {
  const key = `consultee-booking:${consulteeUserId}`;
  try {
    return await acquireLockWithRetry(key, ttl);
  } catch (error) {
    throw new Error(
      "Lock contention: Another booking is in progress for this account. Please try again.",
    );
  }
}

/**
 * Release a consultee booking lock
 * @param lock - The lock instance to release
 */
export async function unlockConsulteeBooking(
  lock: ApprovalLock,
): Promise<void> {
  await releaseLock(lock);
}
