// Shared maintenance Redis keys (edge-safe).
export const REDIS_KEYS = {
  PHASE: "maintenance:phase",
  CONFIG: "maintenance:config",
} as const;
