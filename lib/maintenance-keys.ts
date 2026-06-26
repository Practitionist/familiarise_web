// Single source of truth for the maintenance Redis keys, shared by the edge
// reader (lib/maintenance-edge.ts) and the Node writer (lib/maintenance.ts) so
// the schema can't drift between them. Platform-scoped; no per-org keys (#776).
// Plain constants only — kept edge-safe (no Node/Prisma imports).
export const REDIS_KEYS = {
  PHASE: "maintenance:phase",
  CONFIG: "maintenance:config",
} as const;
