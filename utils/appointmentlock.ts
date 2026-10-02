import { Redis } from "@upstash/redis";
import redisClient, {
  withCircuitBreaker,
  checkRedisHealth,
  RELEASE_LOCK_SCRIPT,
  RENEW_LOCK_SCRIPT,
} from "../lib/redis";
import crypto from "crypto";
import { SlotLockError } from "./errors/SlotLockError";

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class LockContentionError extends Error {
  constructor(
    readonly key: string,
    readonly attempts: number,
  ) {
    super(`Failed to acquire lock for ${key} after ${attempts} attempts`);
    this.name = "LockContentionError";
  }
}

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

export class EventFullError extends Error {
  readonly httpStatus = 409 as const;
  readonly code = "EVENT_SOLD_OUT" as const;
  constructor(readonly appointmentType: string) {
    super(
      `This ${appointmentType.toLowerCase()} is sold out. Your card was not charged.`,
    );
    this.name = "EventFullError";
  }
}

export class BookingLockUnavailableError extends Error {
  readonly httpStatus = 503 as const;
  readonly code = "BOOKING_LOCK_UNAVAILABLE" as const;
  constructor(readonly context: string) {
    super(
      `Cannot secure a booking lock (${context}) right now (locking service unavailable). Please try again shortly.`,
    );
    this.name = "BookingLockUnavailableError";
  }
}

// ============================================================================
// Type Definitions & Configuration
// ============================================================================

export interface ApprovalLock {
  key: string;
  value: string;
  ttl: number;
  acquiredAt: number;
  client: Redis;
}

interface LockRetryConfig {
  retryCount: number;
  retryDelay: number;
  retryJitter: number;
  exponentialBackoff: boolean;
  driftFactor: number;
}

const DEFAULT_RETRY_CONFIG: LockRetryConfig = {
  retryCount: 10,
  retryDelay: 200,
  retryJitter: 200,
  exponentialBackoff: true,
  driftFactor: 0.01,
};

export const REQUEST_PATH_RETRY_CONFIG: LockRetryConfig = {
  ...DEFAULT_RETRY_CONFIG,
  retryCount: 5,
};

const DEFAULT_LOCK_TTL = 60000;

export const CHECKOUT_LOCK_TTL_MS: Record<string, number> = {
  CONSULTATION: 60_000,
  SUBSCRIPTION: 120_000,
  WEBINAR: 120_000,
  CLASS: 600_000,
};

// ============================================================================
// Core Lock Operations
// ============================================================================

function generateLockValue(): string {
  return crypto.randomUUID();
}

function calculateRetryDelay(attempt: number, config: LockRetryConfig): number {
  const baseDelay = config.exponentialBackoff
    ? config.retryDelay * Math.pow(2, attempt)
    : config.retryDelay;
  const jitter = Math.random() * config.retryJitter;
  return baseDelay + jitter;
}

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
        nx: true,
        px: effectiveTTL,
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

async function acquireGuarded(
  key: string,
  ttl: number,
  context: string,
  config: LockRetryConfig = REQUEST_PATH_RETRY_CONFIG,
): Promise<ApprovalLock> {
  if (!(await checkRedisHealth())) {
    throw new BookingLockUnavailableError(context);
  }

  let lock: ApprovalLock | LockContentionError;
  try {
    lock = await withCircuitBreaker<ApprovalLock | LockContentionError>(
      async () => {
        try {
          return await acquireLockWithRetry(key, ttl, config);
        } catch (error) {
          if (error instanceof LockContentionError) return error;
          throw error;
        }
      },
    );
  } catch (error: unknown) {
    console.error(
      JSON.stringify({
        event: "booking_lock_unavailable",
        key,
        context,
        error: getErrorMessage(error),
        timestamp: new Date().toISOString(),
      }),
    );
    throw new BookingLockUnavailableError(context);
  }

  if (lock instanceof LockContentionError) {
    throw lock;
  }
  return lock;
}

async function releaseLock(lock: ApprovalLock): Promise<void> {
  try {
    const result = await lock.client.eval(
      RELEASE_LOCK_SCRIPT ?? 'redis.call("del", KEYS[1])',
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
  } catch (error: unknown) {
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

export async function extendLock(
  lock: ApprovalLock,
  additionalTtl: number = 30000,
): Promise<boolean> {
  try {
    const result = await lock.client.eval(
      RENEW_LOCK_SCRIPT ??
        'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("pexpire", KEYS[1], ARGV[2]) else return 0 end',
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
// Public API - Approval & Recording Purchase Locks
// ============================================================================

export async function lockConsultationApproval(
  consultationId: string,
  ttl: number = DEFAULT_LOCK_TTL,
): Promise<ApprovalLock> {
  const key = `consultation-approval:${consultationId}`;
  try {
    return await acquireGuarded(key, ttl, "consultation-approval");
  } catch (error) {
    if (error instanceof BookingLockUnavailableError) throw error;
    throw new Error(
      "Lock contention: Another approval is in progress for this consultation. Please try again.",
    );
  }
}

export const APPROVAL_LOCK_TTL_MS = 45_000;

export async function lockSubscriptionApproval(
  subscriptionId: string,
  ttl: number = DEFAULT_LOCK_TTL,
): Promise<ApprovalLock> {
  const key = `subscription-approval:${subscriptionId}`;
  try {
    return await acquireGuarded(key, ttl, "subscription-approval");
  } catch (error) {
    if (error instanceof BookingLockUnavailableError) throw error;
    throw new Error(
      "Lock contention: Another approval is in progress for this subscription. Please try again.",
    );
  }
}

export async function lockApprovalPaymentMint(
  kind: "CONSULTATION" | "SUBSCRIPTION" | "TRIAL",
  id: string,
  ttl: number = DEFAULT_LOCK_TTL,
): Promise<ApprovalLock> {
  const key = `approval-payment-mint:${kind.toLowerCase()}:${id}`;
  try {
    return await acquireGuarded(key, ttl, "approval-payment-mint");
  } catch (error) {
    if (error instanceof BookingLockUnavailableError) throw error;
    throw new Error(
      "Lock contention: a payment link is already being created for this request. Please try again.",
    );
  }
}

export class RecordingPurchaseInProgressError extends Error {
  readonly code = "RECORDING_PURCHASE_IN_PROGRESS" as const;
  readonly httpStatus = 409 as const;
  constructor() {
    super("This purchase is already being started. Please try again.");
    this.name = "RecordingPurchaseInProgressError";
  }
}

export const RECORDING_PURCHASE_LOCK_TTL_MS = 30_000;

export async function lockRecordingPurchase<T>(
  recordingId: string,
  buyerId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = `recording-purchase:${recordingId}:${buyerId}`;
  let lock: ApprovalLock;
  try {
    lock = await acquireGuarded(
      key,
      RECORDING_PURCHASE_LOCK_TTL_MS,
      "recording-purchase",
    );
  } catch (error) {
    if (error instanceof BookingLockUnavailableError) throw error;
    throw new RecordingPurchaseInProgressError();
  }
  try {
    return await fn();
  } finally {
    await releaseLock(lock);
  }
}

export async function unlockApproval(lock: ApprovalLock): Promise<void> {
  await releaseLock(lock);
}

export class ApprovalLockLostError extends Error {
  readonly code = "APPROVAL_LOCK_LOST";
  readonly httpStatus = 409;
  readonly key: string;
  constructor(key: string) {
    super(
      "This request is being processed by another action. Please refresh and try again.",
    );
    this.name = "ApprovalLockLostError";
    this.key = key;
  }
}

export async function renewApprovalLock(
  lock: ApprovalLock | null | undefined,
  ttl: number = APPROVAL_LOCK_TTL_MS,
): Promise<void> {
  if (!lock) return;
  if (!(await extendLock(lock, ttl))) throw new ApprovalLockLostError(lock.key);
}

// ============================================================================
// Public API - Slot Booking Locks (30-minute interval atoms)
// ============================================================================

const SLOT_ATOM_MS = 30 * 60 * 1000;

const INTERVAL_RETRY_CONFIG: LockRetryConfig = {
  ...DEFAULT_RETRY_CONFIG,
  retryCount: 5,
};

export const CHECKOUT_WAIT_RETRY_CONFIG: LockRetryConfig = {
  ...DEFAULT_RETRY_CONFIG,
  retryCount: 5,
};

export class EventCheckoutBusyError extends Error {
  readonly httpStatus = 409 as const;
  readonly retryAfterSeconds = 10;
  readonly code = "EVENT_CHECKOUT_BUSY";
  constructor(readonly appointmentType: string) {
    super(
      `Another user is currently checking out this ${appointmentType.toLowerCase()}. Please try again in a few seconds.`,
    );
    this.name = "EventCheckoutBusyError";
  }
}

export class ConsulteeBookingBusyError extends Error {
  readonly httpStatus = 409 as const;
  readonly retryAfterSeconds = 30;
  readonly code = "CONSULTEE_BOOKING_BUSY";
  constructor() {
    super(
      "Another booking is already in progress for your account. Please try again in a moment.",
    );
    this.name = "ConsulteeBookingBusyError";
  }
}

export function slotAtomStarts(startsAt: Date, endsAt: Date): Date[] {
  const floored = Math.floor(startsAt.getTime() / SLOT_ATOM_MS) * SLOT_ATOM_MS;
  const atoms: Date[] = [];
  for (let t = floored; t < endsAt.getTime(); t += SLOT_ATOM_MS) {
    atoms.push(new Date(t));
  }
  return atoms;
}

export async function lockSlotInterval(
  consultantProfileId: string,
  startsAt: Date | string,
  endsAt: Date | string,
  ttl: number = DEFAULT_LOCK_TTL,
): Promise<ApprovalLock[]> {
  const start = new Date(startsAt);
  const end = new Date(endsAt);
  const atoms = slotAtomStarts(start, end);
  if (atoms.length === 0) {
    const fmt = (d: Date, raw: Date | string) =>
      Number.isNaN(d.getTime())
        ? `unparseable(${String(raw)})`
        : d.toISOString();
    throw new Error(
      `lockSlotInterval: empty interval ${fmt(start, startsAt)} → ${fmt(end, endsAt)}`,
    );
  }

  const acquired: ApprovalLock[] = [];
  try {
    for (const atom of atoms) {
      const key = `slot-booking:${consultantProfileId}:${atom.toISOString()}`;
      acquired.push(
        await acquireGuarded(key, ttl, "slot-interval", INTERVAL_RETRY_CONFIG),
      );
    }
    if (acquired.length > 1) {
      const effectiveTTL = Math.floor(
        ttl * (1 - INTERVAL_RETRY_CONFIG.driftFactor),
      );
      for (const lock of acquired) {
        if (!(await extendLock(lock, effectiveTTL))) {
          throw new LockContentionError(lock.key, 1);
        }
      }
    }
    return acquired;
  } catch (error) {
    for (const lock of [...acquired].reverse()) {
      await releaseLock(lock);
    }
    if (error instanceof LockContentionError) {
      const conflictingAtom =
        atoms[acquired.length]?.toISOString() ?? String(startsAt);
      throw new SlotLockError(consultantProfileId, conflictingAtom, 60);
    }
    throw error;
  }
}

export async function unlockSlotInterval(locks: ApprovalLock[]): Promise<void> {
  for (const lock of [...locks].reverse()) {
    await releaseLock(lock);
  }
}

export async function extendSlotInterval(
  locks: ApprovalLock[],
  additionalTtl: number,
): Promise<boolean> {
  for (const lock of locks) {
    if (!(await extendLock(lock, additionalTtl))) return false;
  }
  return true;
}

export async function lockSlotBooking(
  consultantProfileId: string,
  startsAt: string,
  endsAt: string,
  ttl: number = DEFAULT_LOCK_TTL,
): Promise<ApprovalLock[]> {
  return lockSlotInterval(consultantProfileId, startsAt, endsAt, ttl);
}

export async function unlockSlotBooking(locks: ApprovalLock[]): Promise<void> {
  await unlockSlotInterval(locks);
}

// ============================================================================
// Public API - Event Checkout, Appointment, Auto-Allocate & Consultee Locks
// ============================================================================

export async function lockEventCheckout(
  appointmentType: string,
  eventOrPlanId: string,
  ttl: number = DEFAULT_LOCK_TTL,
  retryConfig: LockRetryConfig = REQUEST_PATH_RETRY_CONFIG,
): Promise<ApprovalLock> {
  const key = `event-checkout:${appointmentType}:${eventOrPlanId}`;
  try {
    return await acquireGuarded(key, ttl, appointmentType, retryConfig);
  } catch (error) {
    if (error instanceof BookingLockUnavailableError) {
      throw new EventCheckoutLockUnavailableError(appointmentType);
    }
    throw new EventCheckoutBusyError(appointmentType);
  }
}

export async function unlockEventCheckout(lock: ApprovalLock): Promise<void> {
  await releaseLock(lock);
}

export const APPOINTMENT_LOCK_TTL_MS = 75_000;

export class AppointmentBusyError extends Error {
  readonly httpStatus = 423 as const;
  readonly code = "APPOINTMENT_BUSY" as const;
  constructor(readonly appointmentId: string) {
    super("This appointment is being updated. Please try again in a moment.");
    this.name = "AppointmentBusyError";
  }
}

export async function lockAppointment(
  appointmentId: string,
  ttl: number = APPOINTMENT_LOCK_TTL_MS,
): Promise<ApprovalLock> {
  const key = `appointment-lock:${appointmentId}`;
  try {
    return await acquireGuarded(key, ttl, "appointment");
  } catch (error) {
    if (error instanceof BookingLockUnavailableError) throw error;
    throw new AppointmentBusyError(appointmentId);
  }
}

export async function unlockAppointment(lock: ApprovalLock): Promise<void> {
  await releaseLock(lock);
}

export async function withAppointmentLock<T>(
  appointmentId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const lock = await lockAppointment(appointmentId);
  try {
    return await fn();
  } finally {
    await unlockAppointment(lock);
  }
}

export async function lockAutoAllocate(
  consultantProfileId: string,
  scope?: string,
  ttl: number = 150000,
): Promise<ApprovalLock> {
  const key = scope
    ? `auto-allocate:${consultantProfileId}:${scope}`
    : `auto-allocate:${consultantProfileId}`;
  try {
    return await acquireGuarded(key, ttl, "auto-allocate");
  } catch (error) {
    if (error instanceof BookingLockUnavailableError) throw error;
    throw new Error(
      "Lock contention: Another auto-allocation is in progress for this consultant. Please try again.",
    );
  }
}

export async function unlockAutoAllocate(lock: ApprovalLock): Promise<void> {
  await releaseLock(lock);
}

export async function lockConsulteeBooking(
  consulteeUserId: string,
  ttl: number = 150000,
  retryConfig: LockRetryConfig = REQUEST_PATH_RETRY_CONFIG,
): Promise<ApprovalLock> {
  const key = `consultee-booking:${consulteeUserId}`;
  try {
    return await acquireGuarded(key, ttl, "consultee-booking", retryConfig);
  } catch (error) {
    if (error instanceof BookingLockUnavailableError) throw error;
    throw new ConsulteeBookingBusyError();
  }
}

export async function unlockConsulteeBooking(
  lock: ApprovalLock,
): Promise<void> {
  await releaseLock(lock);
}
