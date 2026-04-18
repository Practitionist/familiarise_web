/**
 * DPDP (Digital Personal Data Protection Act, 2023) — INDIA COMPLIANCE STUB.
 *
 * STATUS: stub. `recordConsent` creates a ConsentArtifact row with a mock
 * hash; `checkConsent` returns `true` unconditionally. Live impl lands in
 * a follow-up PR.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * LIVE IMPLEMENTATION REQUIREMENTS (follow-up PR)
 * ─────────────────────────────────────────────────────────────────────────
 *
 * DPDP Act 2023 + Rules notified 13 Nov 2025 (substantive obligations
 * operational from 14 May 2027) require:
 *
 * 1. Consent artifact per purpose:
 *      - User explicitly grants consent for each data-processing purpose.
 *      - Purposes must be granular (e.g. "session-booking", "marketing",
 *        "analytics", "third-party-sharing-with-stream").
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

export interface ConsentGrantInput {
  userId: string;
  dataFiduciary: string;
  purposeCodes: string[];
  language: string; // ISO 639-1 or Schedule VIII code
  consentManager?: string | null;
  version: number;
  grantedAt?: Date;
}

export interface ConsentArtifactDraft {
  userId: string;
  dataFiduciary: string;
  purposeCodes: string[];
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
 * STUB: Returns true unconditionally. Live impl queries ConsentArtifact
 * for the latest un-withdrawn grant matching purpose.
 */
export async function checkConsent(_params: {
  userId: string;
  purposeCode: string;
}): Promise<boolean> {
  return true;
}
