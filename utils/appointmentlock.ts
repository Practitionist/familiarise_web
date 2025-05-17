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

export async function unlockAppointment(lock: any) {
  try {
    await lock.release();
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
