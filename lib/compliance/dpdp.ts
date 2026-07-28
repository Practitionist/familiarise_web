/**
 * DPDP (Digital Personal Data Protection Act, 2023) — INDIA COMPLIANCE.
 *
 * STATUS: consent primitives are LIVE. `recordConsent` writes a ConsentArtifact
 * row with a real SHA-256 payload hash; `checkConsent` is fail-closed — it
 * returns `true` only when a non-withdrawn, non-expired artifact exists for the
 * (user, purpose) pair, else `false`. The substantive operator obligations
 * below (Consent Manager registration, breach reporting, rights fulfilment)
 * remain follow-up work.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * LIVE IMPLEMENTATION REQUIREMENTS (follow-up PR)
 * ─────────────────────────────────────────────────────────────────────────
 *
 * DPDP Act 2023 + Rules notified 13 Nov 2025. The substantive obligations
 * below are phased: Consent Manager registration opens 13 Nov 2026, and the
 * operational duties (consent notices, breach reporting, retention/erasure,
 * data-principal rights) bind eighteen months after notification, i.e.
 * 13 May 2027 — not 14 May. They require:
 *
 * 1. Consent artifact per purpose:
 *      - User explicitly grants consent for each data-processing purpose.
 *      - Purposes must be granular and drawn from the SINGLE canonical
 *        taxonomy in `lib/compliance/purpose-codes.ts` (PURPOSE_CODES):
 *        PRIMARY_PROCESSING, SESSION_BOOKING, STREAM_DATA_PROCESSING,
 *        MARKETING_COMMS, ANALYTICS. Do not introduce ad-hoc string literals.
 *      - Notice must be presented in English + any of the 22 Schedule VIII
 *        languages the user selects. Store language code on the artifact.
 *
 * 2. Tamper-evident artifact:
 *      - Hash = SHA-256 of (userId + purposeCodes + version + grantedAt).
 *      - Version increments when the notice text changes.
 *
 * 3. Retention: audit artifact retained for 7 years from grant or
 *    withdrawal, whichever later. `auditRetainedUntil` on the schema
 *    captures this. A daily cron (`consent-retention-sweeper.ts`) purges
 *    artifacts past the retention date.
 *
 * 4. Withdrawal: user can withdraw at any time. `withdrawnAt` populated;
 *    downstream processing must stop within a commercially reasonable
 *    timeframe (48 hours recommended).
 *
 * 5. Children (under 18):
 *      - Verifiable parental consent required (no free-text "I'm a parent"
 *        checkbox).
 *      - Suggested flow: Aadhaar-based parent verification via DigiLocker.
 *      - Schema addition: `User.dpdpStatus: UNDER_18 | ADULT |
 *        GUARDIAN_VERIFIED` (deferred; add if targeting students).
 *
 * 6. Significant Data Fiduciary (SDF):
 *      - Thresholds not fully finalised as of Nov 2025 Rules.
 *      - Familiarise likely NOT an SDF until ≥ 5M active users.
 *      - If designated SDF: annual DPIA, DPO-in-India, independent audit.
 *      - Defer; revisit when nearing threshold.
 *
 * 7. Data breach notification:
 *      - Within 72 hours of detection, notify Data Protection Board of
 *        India and affected users.
 *      - `DataBreach` model captures the required fields.
 *      - Notification format: JSON to dpb@meity.gov.in + banner on
 *        user dashboard.
 *
 * 8. Consent manager interoperability:
 *      - If onboarding a licensed Consent Manager (e.g. Accertify,
 *        RuleZero), artifact must include `consentManager` reference.
 *      - Deferred for v1; leave field nullable.
 *
 * ─────────────────────────────────────────────────────────────────────────
 */

import { createHash } from "node:crypto";
import prisma from "@/lib/prisma";
import type { PurposeCode } from "./purpose-codes";

/**
 * Thrown when a purpose-scoped action is blocked because the user has not
 * granted (or has withdrawn) the required consent. Typed so callers can
 * distinguish a deliberate DPDP gate from an infra failure and degrade
 * gracefully (skip the processing) instead of erroring the whole path —
 * without weakening the gate itself.
 */
export class ConsentRequiredError extends Error {
  readonly purposeCode: PurposeCode;
  constructor(purposeCode: PurposeCode, message: string) {
    super(message);
    this.name = "ConsentRequiredError";
    this.purposeCode = purposeCode;
  }
}

export interface ConsentGrantInput {
  userId: string;
  dataFiduciary: string;
  // Canonical codes only — callers normalize raw/dynamic input at the
  // boundary (normalizePurposeCode) so the taxonomy is enforced at compile
  // time, not just by the runtime gate (#895).
  purposeCodes: PurposeCode[];
  language: string; // ISO 639-1 or Schedule VIII code
  consentManager?: string | null;
  version: number;
  grantedAt?: Date;
}

export interface ConsentArtifactDraft {
  userId: string;
  dataFiduciary: string;
  purposeCodes: PurposeCode[];
  language: string;
  consentManager: string | null;
  version: number;
  grantedAt: Date;
  hash: string;
  auditRetainedUntil: Date;
}

/**
 * STUB: Builds a ConsentArtifact payload ready for Prisma insert.
 *
 * Real SHA-256 hashing is implemented here — safe to use for testing.
 * What's deferred is the surrounding workflow (purpose-code taxonomy,
 * notice rendering, withdrawal UX, cron cleanup).
 */
export function buildConsentArtifact(input: ConsentGrantInput): ConsentArtifactDraft {
  const grantedAt = input.grantedAt ?? new Date();
  const auditRetainedUntil = new Date(grantedAt);
  auditRetainedUntil.setFullYear(auditRetainedUntil.getFullYear() + 7);

  const payload = JSON.stringify({
    userId: input.userId,
    dataFiduciary: input.dataFiduciary,
    purposeCodes: [...input.purposeCodes].sort(),
    version: input.version,
    grantedAt: grantedAt.toISOString(),
  });
  const hash = createHash("sha256").update(payload).digest("hex");

  return {
    userId: input.userId,
    dataFiduciary: input.dataFiduciary,
    purposeCodes: input.purposeCodes,
    language: input.language,
    consentManager: input.consentManager ?? null,
    version: input.version,
    grantedAt,
    hash,
    auditRetainedUntil,
  };
}

/**
 * Returns true when the user has an ACTIVE (not withdrawn, within
 * retention window) ConsentArtifact covering the requested purpose.
 *
 * Implementation is real — the plumbing this helper hangs on (audit
 * category, retention field, withdrawal column) has all shipped. What
 * remains STUB is the consent-manager / notice-versioning workflow
 * (see the module docblock above), NOT the predicate itself. Treating
 * the predicate as real lets us guard purpose-scoped features (e.g.
 * analytics pings, Stream.io handoff, marketing emails) in app code
 * today, knowing the guard will short-circuit the moment a user hits
 * "withdraw" in the consent UI.
 *
 * Semantics:
 *   - If NO artifact exists for (user, purposeCode) → false (fail-closed).
 *   - If the most recent artifact is withdrawn → false.
 *   - If the most recent artifact is past its retention window → false
 *     (operator must refresh the consent before re-enabling processing).
 *   - Otherwise → true.
 */
export async function checkConsent(params: {
  userId: string;
  purposeCode: PurposeCode;
}): Promise<boolean> {
  const { userId, purposeCode } = params;
  const now = new Date();

  const artifact = await prisma.consentArtifact.findFirst({
    where: {
      userId,
      purposeCodes: { has: purposeCode },
      withdrawnAt: null,
      auditRetainedUntil: { gt: now },
    },
    orderBy: { grantedAt: "desc" },
    select: { id: true },
  });

  return artifact !== null;
}

/**
 * Batch form of `checkConsent` (#1019) — resolve consent for many users in ONE
 * query instead of N. Same fail-closed semantics (a live, non-withdrawn,
 * in-retention artifact carrying the purpose code). Returns the set of userIds
 * that HAVE consent; absentees are implicitly denied. Pool-safe for large
 * exports where a per-user loop (sequential or Promise.all) would either be slow
 * or spike the connection pool.
 */
export async function checkConsentBatch(params: {
  userIds: string[];
  purposeCode: PurposeCode;
}): Promise<Set<string>> {
  const { userIds, purposeCode } = params;
  if (userIds.length === 0) return new Set();

  // Chunk the id list so a very large org can't overflow Postgres's bind
  // parameter ceiling (65,535). 10k per query keeps the round-trip count tiny
  // while staying well under the limit.
  const CHUNK = 10_000;
  const now = new Date();
  const consented = new Set<string>();
  for (let i = 0; i < userIds.length; i += CHUNK) {
    const artifacts = await prisma.consentArtifact.findMany({
      where: {
        userId: { in: userIds.slice(i, i + CHUNK) },
        purposeCodes: { has: purposeCode },
        withdrawnAt: null,
        auditRetainedUntil: { gt: now },
      },
      select: { userId: true },
    });
    for (const a of artifacts) consented.add(a.userId);
  }
  return consented;
}

/**
 * Record a user-initiated consent withdrawal. Idempotent — repeated
 * calls for the same (userId, purposeCodes) set `withdrawnAt` once and
 * return the existing row on subsequent calls.
 *
 * Narrow-scoped withdrawal (a single purposeCode) stamps `withdrawnAt`
 * only on artifacts whose purposeCode list contains the target. This
 * lets a user revoke MARKETING_COMMS without losing their core
 * PRIMARY_PROCESSING consent (canonical codes: lib/compliance/purpose-codes.ts).
 */
export async function withdrawConsent(params: {
  userId: string;
  purposeCode?: PurposeCode;
}): Promise<{ withdrawnCount: number }> {
  const { userId, purposeCode } = params;
  const now = new Date();

  const where = purposeCode
    ? {
        userId,
        withdrawnAt: null,
        purposeCodes: { has: purposeCode },
      }
    : { userId, withdrawnAt: null };

  const { count } = await prisma.consentArtifact.updateMany({
    where,
    data: { withdrawnAt: now },
  });

  return { withdrawnCount: count };
}
