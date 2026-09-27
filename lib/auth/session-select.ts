import type { Prisma } from "@prisma/client";
import { deriveDeviceLabel } from "@/lib/auth/device-label";

/**
 * The session visibility boundary (#1856, ADR 35).
 *
 * A session TOKEN is a bearer credential for the whole account. In
 * BetterAuth 1.6.5 (and 1.7.6) `listSessions()` returns the raw token
 * for every device, so the browser must never call it — every session
 * list in this app reads through THIS select instead. `token` is absent
 * by construction, and `userAgent` is read only to derive the display
 * label: the raw string never leaves the server (it is a fingerprint).
 *
 * `__tests__/security/session-payload-allowlist.test.ts` pins both the
 * select keys and the mapper output keys — adding `token` (or any new
 * column) to either fails the suite, the same tripwire ADR 20 sets for
 * org content fields.
 */
export const SESSION_PUBLIC_SELECT = {
  id: true,
  createdAt: true,
  updatedAt: true,
  expiresAt: true,
  ipAddress: true,
  userAgent: true,
  deviceLabel: true,
  lastSeenAt: true,
  impersonatedBy: true,
} as const;

export type SessionPublicRow = Prisma.SessionGetPayload<{
  select: typeof SESSION_PUBLIC_SELECT;
}>;

export interface PublicSession {
  id: string;
  /** Human label: persisted `deviceLabel`, else derived from `userAgent`. */
  label: string;
  ipAddress: string | null;
  createdAt: Date;
  /**
   * Last server-validated activity, ±5 min. Falls back to `updatedAt`
   * for rows written before the deploy (refresh-driven, coarser) until
   * the first throttled touch lands. Never true "last active" — the UI
   * copy must say "last seen", never "active now".
   */
  lastSeenAt: Date;
  expiresAt: Date;
  /** True when this row is the caller's own session. */
  isCurrent: boolean;
  /** Set when the row belongs to a staff impersonation (not enabled, #693). */
  isImpersonated: boolean;
}

export function toPublicSession(
  row: SessionPublicRow,
  currentSessionId?: string,
): PublicSession {
  return {
    id: row.id,
    label: row.deviceLabel ?? deriveDeviceLabel(row.userAgent),
    ipAddress: row.ipAddress,
    createdAt: row.createdAt,
    lastSeenAt: row.lastSeenAt ?? row.updatedAt,
    expiresAt: row.expiresAt,
    isCurrent: currentSessionId !== undefined && row.id === currentSessionId,
    isImpersonated: row.impersonatedBy !== null,
  };
}
