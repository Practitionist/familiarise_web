import { Redis } from "@upstash/redis";
import Redlock from "redlock";
import redisClient from "../lib/redis";

if (!redisClient) {
  throw new Error("Redis client is not initialized");
}

const redlock = new Redlock(
  // You can have multiple clients here for redundancy
  [redisClient as any],
  {
    // The maximum number of times Redlock will attempt to lock a resource
    // before erroring.
    driftFactor: 0.01, // time in ms
    retryCount: 10,
    retryDelay: 200, // time in ms
    retryJitter: 200, // time in ms
  },
);

export async function lockAppointment(
  appointmentId: string,
  ttl: number = 300000,
) {
  // default 5 minutes
  try {
    const lock = await redlock.acquire(
      [`appointment-lock:${appointmentId}`],
      ttl,
    );
    return lock;
  } catch (error) {
    console.error("Failed to acquire lock:", error);
    throw new Error("Failed to lock appointment");
  }
}

export async function unlockAppointment(
  lock: Awaited<ReturnType<typeof lockAppointment>>,
) {
  try {
    await redlock.release(lock);
  } catch (error) {
    console.error("Failed to release lock:", error);
    throw new Error("Failed to unlock appointment");
  }
}

export async function isAppointmentLocked(
  appointmentId: string,
): Promise<boolean> {
  try {
    if (!redisClient) {
      throw new Error("Redis client is not initialized");
    }
    const exists = await redisClient.exists(
      `appointment-lock:${appointmentId}`,
    );
    return exists === 1;
  } catch (error) {
    console.error("Failed to check lock status:", error);
    throw new Error("Failed to check appointment lock status");
  }
}

// ============================================================================
// Approval Payment Locks (for race condition protection)
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
) {
  try {
    const lock = await redlock.acquire(
      [`consultation-approval:${consultationId}`],
      ttl,
    );
    return lock;
  } catch (error) {
    console.error(
      `Failed to acquire lock for consultation ${consultationId}:`,
      error,
    );
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
) {
  try {
    const lock = await redlock.acquire(
      [`subscription-approval:${subscriptionId}`],
      ttl,
    );
    return lock;
  } catch (error) {
    console.error(
      `Failed to acquire lock for subscription ${subscriptionId}:`,
      error,
    );
    throw new Error(
      "Another approval is in progress for this subscription. Please try again.",
    );
  }
}

/**
 * Release an approval lock
 * @param lock - The lock instance to release
 */
export async function unlockApproval(
  lock: Awaited<ReturnType<typeof lockConsultationApproval>>,
) {
  try {
    await redlock.release(lock);
  } catch (error) {
    console.error("Failed to release approval lock:", error);
    // Don't throw - lock will expire anyway based on TTL
  }
}
