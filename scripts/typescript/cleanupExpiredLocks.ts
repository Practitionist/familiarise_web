import redisClient from "../../lib/redis";

if (!redisClient) {
  throw new Error("Redis client is not initialized");
}

async function cleanupExpiredLocks() {
  try {
    // Redis automatically removes expired keys, so we don't need to manually clean them up
    console.log(
      "Redis automatically handles expired locks - no cleanup needed",
    );
  } catch (error) {
    console.error("Error:", error);
  }
}

// Note: This script is kept for documentation purposes, but it's not needed
// since Redis automatically removes expired keys through its built-in expiration mechanism.
// The lockAppointment function in lib/appointmentlock.ts sets TTL when creating locks,
// and Redis automatically removes them when they expire.

export default cleanupExpiredLocks;
