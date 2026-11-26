import { Redis } from "@upstash/redis";
import redisClient, {
  withCircuitBreaker,
  checkRedisHealth,
} from "../lib/redis";
import {
  RELEASE_LOCK_SCRIPT,
  RENEW_LOCK_SCRIPT,
  SLOT_BATCH_ACQUIRE_SCRIPT,
  SLOT_BATCH_RELEASE_SCRIPT,
  SLOT_BATCH_RENEW_SCRIPT,
} from "../lib/redis-mock";
import crypto from "crypto";
import * as Sentry from "@sentry/nextjs";
import { SCHEDULING_INTERVAL_MS } from "../lib/appointments/occurrences";
import { SlotLockError } from "./errors/SlotLockError";
import { Refusal } from "../lib/errors/refusal";

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * One warning-level Sentry log per contended acquisition (slow path only; a
 * modelled outcome, not a fault). Tagged by atom family, a closed set — the key
 * itself embeds ids and would be an unbounded-cardinality tag. Never throws.
 */
function reportLockContention(
  family: string,
  detail: Record<string, unknown>,
): void {
  try {
    Sentry.logger.warn("booking lock contended", {
      tags: { subsystem: "booking", op: "lock-contention", family },
      ...detail,
    });
  } catch {
    // Telemetry must never be the reason a booking fails.
  }
}

export class LockContentionError extends Error {
  readonly code = "LOCK_CONTENTION" as const;
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
  /** The acquire's per-call bound, kept for the release. */
  callTimeoutMs?: number;
}

interface LockRetryConfig {
  retryCount: number;
  retryDelay: number;
  retryJitter: number;
  exponentialBackoff: boolean;
  driftFactor: number;
  /** Bounds each Redis call; a stalled call fails the acquire at once, never retried. */
  callTimeoutMs?: number;
  /** Epoch ms past which the acquire makes no Redis call and no retry wait; out of time reads as contention. */
  deadlineAt?: number;
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

/**
 * The allocator's wait per lock tier (appointment, consultant, consultee):
 * at most ~0.9 s, so three tiers stay inside the allocate request budget.
 */
export const ALLOCATOR_LOCK_RETRY_CONFIG: LockRetryConfig = {
  ...DEFAULT_RETRY_CONFIG,
  retryCount: 2,
  retryJitter: 150,
};

/** A sweep's wait for one booking's lock: ~0.9 s of backoff and 1.5 s per Redis call, then the booking waits for the next run. */
export const SWEEP_LOCK_RETRY_CONFIG = {
  ...DEFAULT_RETRY_CONFIG,
  retryCount: 2,
  retryJitter: 150,
  callTimeoutMs: 1_500,
} satisfies LockRetryConfig;

const DEFAULT_LOCK_TTL = 60000;

/**
 * One checkout attempt plus slack; renewed per attempt. An event key held by
 * a crashed invocation stalls that event's sales for at most this long.
 */
export const CHECKOUT_LOCK_TTL_MS: Record<string, number> = {
  CONSULTATION: 60_000,
  SUBSCRIPTION: 45_000,
  WEBINAR: 45_000,
  CLASS: 45_000,
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

/** A Redis call that outlived its bound; the TTL frees any key it set later. */
class RedisCallTimeout extends Error {
  constructor(ms: number) {
    super(`Redis call timed out after ${ms} ms`);
    this.name = "RedisCallTimeout";
  }
}

/** `pending`, or a RedisCallTimeout after `ms`; unbounded when `ms` is undefined. */
async function withCallTimeout<T>(
  pending: Promise<T>,
  ms: number | undefined,
): Promise<T> {
  if (ms === undefined) return pending;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new RedisCallTimeout(ms)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * The next Redis call's bound: the smaller of the per-call bound and the time
 * left before `deadlineAt`, and whether the deadline is what limits it. A tie is
 * the deadline's, since a caller may size the per-call bound to the time left.
 */
function callBound(config: LockRetryConfig): {
  ms: number | undefined;
  byDeadline: boolean;
} {
  if (config.deadlineAt === undefined) {
    return { ms: config.callTimeoutMs, byDeadline: false };
  }
  const left = config.deadlineAt - Date.now();
  const perCall = config.callTimeoutMs ?? Infinity;
  return { ms: Math.min(perCall, left), byDeadline: left <= perCall };
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
    const { ms: bound, byDeadline } = callBound(config);
    if (bound !== undefined && bound <= 0) {
      throw new LockContentionError(key, attempt);
    }
    try {
      const result = await withCallTimeout(
        client.set(key, value, { nx: true, px: effectiveTTL }),
        bound,
      );

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
          callTimeoutMs: config.callTimeoutMs,
        };
      }

      if (attempt < config.retryCount) {
        const delay = calculateRetryDelay(attempt, config);
        if (
          config.deadlineAt !== undefined &&
          Date.now() + delay >= config.deadlineAt
        ) {
          throw new LockContentionError(key, attempt + 1);
        }
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
      // Out of time after a refused SET: no key of ours to clean up.
      if (error instanceof LockContentionError) throw error;
      console.error(
        JSON.stringify({
          event: "lock_error",
          key,
          attempt: attempt + 1,
          error: getErrorMessage(error),
          timestamp: new Date().toISOString(),
        }),
      );
      // The SET may have landed before the error: delete it only if it is ours,
      // so neither the retry nor the next caller meets our own key as contention.
      await releaseIfOurs(client, key, value, config.deadlineAt);

      // A call cut short by the deadline, not by its own bound, is out of time: no breaker failure.
      if (error instanceof RedisCallTimeout && byDeadline) {
        throw new LockContentionError(key, attempt + 1);
      }
      if (attempt === config.retryCount || error instanceof RedisCallTimeout) {
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
  const { ms: probeBound } = callBound(config);
  if (probeBound !== undefined && probeBound <= 0) {
    throw new LockContentionError(key, 0);
  }
  // A stalled PING reads as Redis unavailable for this caller only; it is not cached as unhealthy.
  const healthy = await withCallTimeout(checkRedisHealth(), probeBound).catch(
    () => false,
  );
  if (!healthy) {
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
    // Every booking atom, event checkout included, contends through here.
    reportLockContention(context, { key, attempts: lock.attempts });
    throw lock;
  }
  return lock;
}

/** Best-effort compare-and-delete of a key this process may have written; never throws. */
async function releaseIfOurs(
  client: Redis,
  key: string,
  value: string,
  deadlineAt?: number,
): Promise<void> {
  const left =
    deadlineAt === undefined
      ? SLOT_BATCH_REDIS_TIMEOUT_MS
      : deadlineAt - Date.now();
  // Past the caller's deadline no further call starts; the TTL frees the key.
  if (left <= 0) return;
  try {
    await withCallTimeout(
      client.eval(RELEASE_LOCK_SCRIPT, [key], [value]),
      Math.min(SLOT_BATCH_REDIS_TIMEOUT_MS, left),
    );
  } catch {
    // The TTL still frees the key; the caller's own error is the one to report.
  }
}

async function releaseLock(lock: ApprovalLock): Promise<void> {
  try {
    const result = await withCallTimeout(
      lock.client.eval(RELEASE_LOCK_SCRIPT, [lock.key], [lock.value]),
      lock.callTimeoutMs,
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
      try {
        const family = lock.key.split(":")[0] || "unknown";
        Sentry.logger?.warn("booking lock expired before release", {
          family,
          held_duration_ms: heldDuration,
        });
        Sentry.metrics?.count("booking.lock_already_released", 1, {
          attributes: { family },
        });
      } catch {
        // Telemetry must never be the reason a booking fails.
      }
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
      RENEW_LOCK_SCRIPT,
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
    try {
      const family = lock.key.split(":")[0] || "unknown";
      Sentry.logger?.warn("booking lock extension failed — ownership lost", {
        family,
        additional_ttl_ms: additionalTtl,
      });
      Sentry.metrics?.count("booking.lock_ownership_lost", 1, {
        attributes: { family },
      });
    } catch {
      // Telemetry must never be the reason a booking fails.
    }
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
  kind: "CONSULTATION" | "TRIAL",
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

export class DigitalProductPurchaseInProgressError extends Error {
  readonly code = "DIGITAL_PRODUCT_PURCHASE_IN_PROGRESS" as const;
  readonly httpStatus = 409 as const;
  constructor() {
    super("This purchase is already being started. Please try again.");
    this.name = "DigitalProductPurchaseInProgressError";
  }
}

/** One order mint or free claim per (product, buyer) at a time. */
export async function lockDigitalProductPurchase<T>(
  productId: string,
  buyerId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = `digital-product-purchase:${productId}:${buyerId}`;
  let lock: ApprovalLock;
  try {
    lock = await acquireGuarded(
      key,
      RECORDING_PURCHASE_LOCK_TTL_MS,
      "digital-product-purchase",
    );
  } catch (error) {
    if (error instanceof BookingLockUnavailableError) throw error;
    throw new DigitalProductPurchaseInProgressError();
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

const SLOT_ATOM_MS = SCHEDULING_INTERVAL_MS;

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
  constructor(
    readonly appointmentType: string,
    /** Who is refused: a buyer, or the host changing the event. */
    refused: "buyer" | "host" = "buyer",
  ) {
    const kind = appointmentType.toLowerCase();
    super(
      refused === "host"
        ? `Someone is booking a seat on this ${kind} right now. Please try again in a few seconds.`
        : `Another user is currently checking out this ${kind}. Please try again in a few seconds.`,
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

/** One profile's interval a write makes busy; a batch spans every profile the write touches. */
export interface SlotBatchEntry {
  consultantProfileId: string;
  startsAt: Date | string;
  endsAt: Date | string;
}

/**
 * A held slot batch: one lock per atom key, all sharing one value, so the
 * batch renews and releases in one round trip and each key still releases on
 * its own compare-value.
 */
export type SlotBatchGrant = ApprovalLock[];

const SLOT_KEY_PREFIX = "slot-booking:";

function slotKey(consultantProfileId: string, atom: Date): string {
  return `${SLOT_KEY_PREFIX}${consultantProfileId}:${atom.toISOString()}`;
}

/** The interval a slot key names, so a refused batch can say which times are taken. */
export function parseSlotKey(
  key: string,
): { consultantProfileId: string; startsAt: Date; endsAt: Date } | null {
  if (!key.startsWith(SLOT_KEY_PREFIX)) return null;
  const rest = key.slice(SLOT_KEY_PREFIX.length);
  const split = rest.indexOf(":");
  if (split <= 0) return null;
  const startsAt = new Date(rest.slice(split + 1));
  if (Number.isNaN(startsAt.getTime())) return null;
  return {
    consultantProfileId: rest.slice(0, split),
    startsAt,
    endsAt: new Date(startsAt.getTime() + SLOT_ATOM_MS),
  };
}

/** Every atom key of every entry, de-duplicated and sorted (a total order across profiles). */
export function slotBatchKeys(entries: readonly SlotBatchEntry[]): string[] {
  const keys = new Set<string>();
  for (const entry of entries) {
    const start = new Date(entry.startsAt);
    const end = new Date(entry.endsAt);
    const atoms = slotAtomStarts(start, end);
    if (atoms.length === 0) {
      const fmt = (d: Date, raw: Date | string) =>
        Number.isNaN(d.getTime())
          ? `unparseable(${String(raw)})`
          : d.toISOString();
      throw new Error(
        `slot batch: empty interval ${fmt(start, entry.startsAt)} → ${fmt(end, entry.endsAt)}`,
      );
    }
    for (const atom of atoms)
      keys.add(slotKey(entry.consultantProfileId, atom));
  }
  // Code-unit order: the lock order must not depend on the runtime's locale.
  return [...keys].sort(byCodeUnit);
}

/** A slow Redis is an unavailable Redis: the booking fails closed (503), never unlocked. */
const SLOT_BATCH_REDIS_TIMEOUT_MS = 1_500;

function evalWithTimeout(
  client: Redis,
  script: string,
  keys: string[],
  args: string[],
): Promise<unknown> {
  return withRedisTimeout(client.eval(script, keys, args));
}

async function withRedisTimeout<T>(pending: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("slot batch: Redis timed out")),
          SLOT_BATCH_REDIS_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * All-or-nothing, never waits: one Lua call sets every key with NX semantics,
 * or sets none and answers which keys are held. Redis down or slow throws
 * BookingLockUnavailableError.
 */
export async function tryLockSlotBatch(
  entries: readonly SlotBatchEntry[],
  ttlMs: number = DEFAULT_LOCK_TTL,
): Promise<
  { ok: true; grant: SlotBatchGrant } | { ok: false; heldKeys: string[] }
> {
  const keys = slotBatchKeys(entries);
  if (!(await checkRedisHealth())) {
    throw new BookingLockUnavailableError("slot-batch");
  }
  const client = redisClient as Redis;
  const value = generateLockValue();
  const ttl = Math.floor(ttlMs * (1 - DEFAULT_RETRY_CONFIG.driftFactor));
  let result: unknown;
  let pending: Promise<unknown> | null = null;
  try {
    result = await withCircuitBreaker(() => {
      pending = client.eval(SLOT_BATCH_ACQUIRE_SCRIPT, keys, [
        value,
        String(ttl),
      ]);
      return withRedisTimeout(pending);
    });
  } catch (error: unknown) {
    // The script may have run (or still run) after we gave up, and a script
    // error does not roll back: give back whatever it set under our value.
    releaseAbandonedBatch(client, keys, value, pending);
    console.error(
      JSON.stringify({
        event: "booking_lock_unavailable",
        context: "slot-batch",
        keys: keys.length,
        error: getErrorMessage(error),
        timestamp: new Date().toISOString(),
      }),
    );
    throw new BookingLockUnavailableError("slot-batch");
  }
  const heldKeys = Array.isArray(result)
    ? result.filter((k): k is string => typeof k === "string")
    : [];
  if (heldKeys.length > 0) return { ok: false, heldKeys };
  const acquiredAt = Date.now();
  return {
    ok: true,
    grant: keys.map((key) => ({ key, value, ttl, acquiredAt, client })),
  };
}

/** Compare-value DEL now and again once the abandoned acquire settles; never throws. */
function releaseAbandonedBatch(
  client: Redis,
  keys: string[],
  value: string,
  pending: Promise<unknown> | null,
): void {
  const release = () =>
    client.eval(SLOT_BATCH_RELEASE_SCRIPT, keys, [value]).catch(() => null);
  void release();
  if (pending) void pending.then(release, release);
}

/**
 * The waiting form for buyer doors (checkout, request, trial): retries the
 * atomic batch inside the request-path budget, then throws SlotLockError
 * naming the first held atom.
 */
export async function lockSlotBatch(
  entries: readonly SlotBatchEntry[],
  ttlMs: number = DEFAULT_LOCK_TTL,
  config: LockRetryConfig = INTERVAL_RETRY_CONFIG,
): Promise<SlotBatchGrant> {
  let heldKeys: string[] = [];
  for (let attempt = 0; attempt <= config.retryCount; attempt++) {
    const outcome = await tryLockSlotBatch(entries, ttlMs);
    if (outcome.ok) return outcome.grant;
    heldKeys = outcome.heldKeys;
    if (attempt < config.retryCount) {
      await new Promise((resolve) =>
        setTimeout(resolve, calculateRetryDelay(attempt, config)),
      );
    }
  }
  reportLockContention("slot-interval", {
    heldKeys: heldKeys.length,
    attempts: config.retryCount + 1,
  });
  const held = parseSlotKey(heldKeys[0] ?? "");
  throw new SlotLockError(
    held?.consultantProfileId ?? entries[0]?.consultantProfileId ?? "unknown",
    held?.startsAt.toISOString() ?? String(entries[0]?.startsAt),
    60,
  );
}

export async function lockSlotInterval(
  consultantProfileId: string,
  startsAt: Date | string,
  endsAt: Date | string,
  ttl: number = DEFAULT_LOCK_TTL,
): Promise<SlotBatchGrant> {
  return lockSlotBatch([{ consultantProfileId, startsAt, endsAt }], ttl);
}

/** Compare-value DEL of every key in one call; never throws. */
export async function unlockSlotInterval(grant: SlotBatchGrant): Promise<void> {
  const [first] = grant;
  if (!first) return;
  try {
    await evalWithTimeout(
      first.client,
      SLOT_BATCH_RELEASE_SCRIPT,
      grant.map((lock) => lock.key),
      [first.value],
    );
  } catch (error: unknown) {
    console.error(
      JSON.stringify({
        event: "lock_release_error",
        context: "slot-batch",
        keys: grant.length,
        error: getErrorMessage(error),
        timestamp: new Date().toISOString(),
      }),
    );
  }
}

/** Re-arm every key to a fresh TTL in one call; false when any key is no longer ours. */
export async function extendSlotInterval(
  grant: SlotBatchGrant,
  additionalTtl: number,
): Promise<boolean> {
  const [first] = grant;
  if (!first) return true;
  try {
    const result = await evalWithTimeout(
      first.client,
      SLOT_BATCH_RENEW_SCRIPT,
      grant.map((lock) => lock.key),
      [first.value, String(additionalTtl)],
    );
    if (result === 1) return true;
    reportLockContention("slot-batch-lost", { keys: grant.length });
    return false;
  } catch (error: unknown) {
    console.error(
      JSON.stringify({
        event: "lock_extension_error",
        context: "slot-batch",
        error: getErrorMessage(error),
        timestamp: new Date().toISOString(),
      }),
    );
    return false;
  }
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
    // The context is the atom family that tags contention telemetry.
    return await acquireGuarded(key, ttl, "event-checkout", retryConfig);
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

/** Outlives one lifecycle transaction (30 s) plus its maxWait, with margin. */
export const EVENT_LIFECYCLE_LOCK_TTL_MS = 75_000;

/**
 * Run `fn` under the event's checkout key, the outermost booking tier (event →
 * appointment → … → slot batch). A null key runs `fn` unlocked: a 1:1 booking
 * has no event key. `renew` re-arms the key; call it at the top of every
 * Serializable attempt so a retry chain never outlives it.
 */
export async function withEventCheckoutLock<T>(
  key: { appointmentType: string; eventId: string } | null,
  fn: (renew: () => Promise<void>) => Promise<T>,
): Promise<T> {
  if (!key) return fn(() => Promise.resolve());
  let lock: ApprovalLock;
  try {
    lock = await lockEventCheckout(
      key.appointmentType,
      key.eventId,
      EVENT_LIFECYCLE_LOCK_TTL_MS,
    );
  } catch (error) {
    if (error instanceof EventCheckoutBusyError) {
      throw new EventCheckoutBusyError(key.appointmentType, "host");
    }
    throw error;
  }
  const renew = async () => {
    if (!(await extendLock(lock, EVENT_LIFECYCLE_LOCK_TTL_MS))) {
      throw new EventCheckoutBusyError(key.appointmentType, "host");
    }
  };
  try {
    return await fn(renew);
  } finally {
    await unlockEventCheckout(lock);
  }
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
  retryConfig: LockRetryConfig = REQUEST_PATH_RETRY_CONFIG,
): Promise<ApprovalLock> {
  const key = `appointment-lock:${appointmentId}`;
  try {
    return await acquireGuarded(key, ttl, "appointment", retryConfig);
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
  /** Receives the grant so a retry-loop body can re-grant it per attempt. */
  fn: (lock: ApprovalLock) => Promise<T>,
  retryConfig: LockRetryConfig = REQUEST_PATH_RETRY_CONFIG,
): Promise<T> {
  const lock = await lockAppointment(
    appointmentId,
    APPOINTMENT_LOCK_TTL_MS,
    retryConfig,
  );
  try {
    return await fn(lock);
  } finally {
    await unlockAppointment(lock);
  }
}

/** The appointment lock's grant lapsed or passed to another writer mid-operation. */
export class LockLostError extends Refusal {
  constructor(key: string) {
    super({
      code: "LOCK_LOST",
      httpStatus: 409,
      userMessage:
        "This booking was being changed somewhere else while we saved. Nothing was changed; please try again.",
      devMessage: `lock lost before renewal: ${key}`,
    });
    this.name = "LockLostError";
  }
}

/**
 * Re-grant the appointment lock for one more attempt; retry loops wrapped in
 * this lock outlive its TTL. Throws {@link LockLostError} (409) when a held
 * grant is no longer ours, so the attempt never runs unserialised; no lock
 * held means nothing to renew.
 */
export async function renewAppointmentLock(
  lock: ApprovalLock | null | undefined,
  ttl: number = APPOINTMENT_LOCK_TTL_MS,
): Promise<void> {
  if (!lock) return;
  if (!(await extendLock(lock, ttl))) throw new LockLostError(lock.key);
}

/** Another allocation for the same expert holds the consultant tier right now. */
export class AutoAllocateBusyError extends Error {
  readonly httpStatus = 409 as const;
  readonly retryAfterSeconds = 5;
  readonly code = "AUTO_ALLOCATE_BUSY" as const;
  constructor() {
    super(
      "Another change to this expert's calendar is in progress. Please try again in a moment.",
    );
    this.name = "AutoAllocateBusyError";
  }
}

export async function lockAutoAllocate(
  consultantProfileId: string,
  ttl: number = 150000,
): Promise<ApprovalLock> {
  const key = `auto-allocate:${consultantProfileId}`;
  try {
    return await acquireGuarded(
      key,
      ttl,
      "auto-allocate",
      ALLOCATOR_LOCK_RETRY_CONFIG,
    );
  } catch (error) {
    if (error instanceof BookingLockUnavailableError) throw error;
    throw new AutoAllocateBusyError();
  }
}

export async function unlockAutoAllocate(lock: ApprovalLock): Promise<void> {
  await releaseLock(lock);
}

export class RequestCapBusyError extends Error {
  readonly httpStatus = 409 as const;
  readonly retryAfterSeconds = 5;
  readonly code = "REQUEST_CAP_BUSY" as const;
  constructor() {
    super(
      "Another request to this expert is being sent right now. Please try again in a moment.",
    );
    this.name = "RequestCapBusyError";
  }
}

/** One expert's open-request cap: held across its count and the request insert. */
export async function lockRequestCap(
  consultantProfileId: string,
  ttl: number = 60_000,
): Promise<ApprovalLock> {
  const key = `request-cap:${consultantProfileId}`;
  try {
    return await acquireGuarded(key, ttl, "request-cap");
  } catch (error) {
    if (error instanceof BookingLockUnavailableError) throw error;
    throw new RequestCapBusyError();
  }
}

export async function unlockRequestCap(lock: ApprovalLock): Promise<void> {
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

/** Code-unit string order (never locale-aware): one lock order on every host. */
export function byCodeUnit(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}
