/**
 * GET  /api/organizations/[orgId]/consent
 * POST /api/organizations/[orgId]/consent
 *
 * DPDP (India) consent-artifact surface, scoped to an org. Consent records
 * live on the global `ConsentArtifact` table — the GET returns only rows
 * stamped with this org's (or the platform's) fiduciary for current members,
 * so it never reveals a member's consent to, or membership of, another org.
 *
 * POST writes a tamper-evident consent row via `buildConsentArtifact`
 * (lib/compliance/dpdp.ts). The SHA-256 hash is real; the surrounding
 * consent-manager + notice-versioning workflow is documented in the dpdp
 * stub header. #1527 decision 5 — only the member grants their own consent:
 * any active member may POST for themselves; an operator granting on behalf
 * of someone else is refused (CONSENT_GRANT_SELF_ONLY). Withdrawing is the
 * member's own act too: operators view (consent.read) and record withdrawal
 * requests (consent.requestWithdrawal, ./withdrawal-requests). Any active
 * member reads and withdraws their OWN consent — the Account settings "Data
 * consent" section (#1527 3c), which also lists their open requests.
 *
 * Retention: `auditRetainedUntil` = grant + 7y, restarted to
 * withdrawal + 7y when the user withdraws, per DPDP Rules (Nov 2025). A
 * weekly sweeper (jobs/compliance/consent-retention-sweeper) reports rows
 * past that date and only deletes them when DPDP_SWEEPER_DELETE is set —
 * this endpoint does NOT delete.
 */

import * as Sentry from "@sentry/nextjs";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";
import { hasOrgPermission } from "@/lib/auth/org-permissions";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";
import {
  buildConsentArtifact,
  orgDataFiduciary,
  PLATFORM_DATA_FIDUCIARY,
  withdrawConsent,
} from "@/lib/compliance/dpdp";
import {
  normalizePurposeCode,
  type PurposeCode,
} from "@/lib/compliance/purpose-codes";

const RequestDetailsSchema = z.object({
  purposeCode: z.string(),
  reason: z.string().nullable().optional(),
});

/**
 * #1527 decision 5 — the member's open withdrawal requests from this org: the
 * newest per purpose, while that consent is live and was not given again after
 * the request. Withdrawing (or re-granting) closes it.
 */
async function openWithdrawalRequests(
  orgId: string,
  membershipId: string,
  userId: string,
) {
  const rows = await prisma.orgAuditLog.findMany({
    where: {
      organizationId: orgId,
      targetMembershipId: membershipId,
      action: AUDIT_ACTIONS.CONSENT.CONSENT_WITHDRAWAL_REQUESTED,
    },
    orderBy: { createdAt: "desc" },
    take: 50,
    select: { id: true, createdAt: true, details: true },
  });
  if (rows.length === 0) return [];

  const artifacts = await prisma.consentArtifact.findMany({
    where: {
      userId,
      dataFiduciary: { in: [orgDataFiduciary(orgId), PLATFORM_DATA_FIDUCIARY] },
      withdrawnAt: null,
      auditRetainedUntil: { gt: new Date() },
    },
    select: { purposeCodes: true, grantedAt: true },
  });
  const latestGrant = new Map<PurposeCode, number>();
  for (const a of artifacts) {
    for (const raw of a.purposeCodes) {
      const code = normalizePurposeCode(raw);
      if (!code) continue;
      const at = a.grantedAt.getTime();
      if (at > (latestGrant.get(code) ?? 0)) latestGrant.set(code, at);
    }
  }

  const open = new Map<
    PurposeCode,
    {
      id: string;
      purposeCode: PurposeCode;
      reason: string | null;
      requestedAt: Date;
    }
  >();
  for (const row of rows) {
    const details = RequestDetailsSchema.safeParse(row.details);
    if (!details.success) continue;
    const code = normalizePurposeCode(details.data.purposeCode);
    if (!code || open.has(code)) continue;
    const grantedAt = latestGrant.get(code);
    if (grantedAt !== undefined && grantedAt < row.createdAt.getTime()) {
      open.set(code, {
        id: row.id,
        purposeCode: code,
        reason: details.data.reason ?? null,
        requestedAt: row.createdAt,
      });
    }
  }
  return [...open.values()];
}

// Schedule VIII of the Indian Constitution enumerates 22 languages.
// Plus English as the lingua franca for enterprise UIs. Accept ISO 639-1
// codes here; the language-label mapping lives client-side.
const LanguageSchema = z
  .string()
  .min(2)
  .max(10)
  .regex(/^[a-z]{2,3}(-[A-Z]{2})?$/, "ISO 639-1/2 language code required");

const CreateBodySchema = z.object({
  // Optional: defaults to the caller. Any other user is refused (#1527).
  userId: z.string().min(1).max(128).optional(),
  purposeCodes: z.array(z.string().min(1).max(64)).min(1).max(20),
  language: LanguageSchema,
  consentManager: z.string().min(1).max(120).nullable().optional(),
  version: z.coerce.number().int().min(1),
});

const QuerySchema = z.object({
  userId: z.string().min(1).max(128).optional(),
  active: z.enum(["true", "false"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  // Any active member reads their own artifacts; consent.read reads everyone's.
  const access = await requireOrgAccess(orgId, { readOnly: true });
  if (access.error) return access.error;
  const selfId = access.session.user.id;
  const readsOthers = hasOrgPermission(access.member.role, "consent.read");

  const url = new URL(req.url);
  const parsedQuery = QuerySchema.safeParse(
    Object.fromEntries(url.searchParams.entries()),
  );
  if (!parsedQuery.success) {
    return NextResponse.json(
      { error: "Invalid query", detail: parsedQuery.error.flatten() },
      { status: 400 },
    );
  }
  const q = parsedQuery.data;
  if (!readsOthers && q.userId && q.userId !== selfId) {
    return NextResponse.json(
      {
        error: "You can only read your own consent",
        code: "CONSENT_READ_SELF_ONLY",
      },
      { status: 403 },
    );
  }
  const userId = readsOthers ? q.userId : selfId;

  // This org's and the platform's artifacts only, for current members: another
  // org's fiduciary rows would reveal the user's membership there.
  const consents = await prisma.consentArtifact.findMany({
    where: {
      ...(userId && { userId }),
      dataFiduciary: { in: [orgDataFiduciary(orgId), PLATFORM_DATA_FIDUCIARY] },
      user: {
        memberships: {
          some: {
            organizationId: orgId,
            status: { in: ["ACTIVE", "SUSPENDED"] },
          },
        },
      },
      ...(q.active === "true" && { withdrawnAt: null }),
      ...(q.active === "false" && { withdrawnAt: { not: null } }),
    },
    select: {
      id: true,
      userId: true,
      dataFiduciary: true,
      purposeCodes: true,
      grantedAt: true,
      withdrawnAt: true,
      language: true,
      consentManager: true,
      version: true,
      hash: true,
    },
    orderBy: { grantedAt: "desc" },
    take: q.limit,
  });

  // Only the member themselves sees the requests addressed to them.
  const withdrawalRequests =
    userId === selfId
      ? await openWithdrawalRequests(orgId, access.member.id, selfId)
      : undefined;

  return NextResponse.json({
    data: consents,
    ...(withdrawalRequests && { withdrawalRequests }),
  });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  // Any active member — granting is the data principal's own act.
  const access = await requireOrgAccess(orgId, { requireActive: true });
  if (access.error) return access.error;

  const raw = await req.json().catch(() => null);
  const parsed = CreateBodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body", detail: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const selfId = access.session.user.id;
  const body = { ...parsed.data, userId: parsed.data.userId ?? selfId };
  // #1527 decision 5 — no operator grants consent on a member's behalf.
  if (body.userId !== selfId) {
    return NextResponse.json(
      {
        error: "Only the member can grant their own consent",
        code: "CONSENT_GRANT_SELF_ONLY",
      },
      { status: 403 },
    );
  }

  // Normalise to the single canonical taxonomy (lib/compliance/purpose-codes.ts)
  // before storage, so the fail-closed runtime gate and the dashboard never
  // diverge again. `normalizePurposeCode` returns undefined for codes that are
  // neither a legacy alias nor already canonical — reject the whole request
  // rather than silently storing/dropping them, so non-canonical strings can
  // never re-enter the taxonomy.
  const normalized = body.purposeCodes.map((c) => ({
    raw: c,
    code: normalizePurposeCode(c),
  }));
  const unknown = normalized
    .filter((n) => n.code === undefined)
    .map((n) => n.raw);
  if (unknown.length > 0) {
    return NextResponse.json(
      { error: "Unknown purpose code(s)", detail: { unknown } },
      { status: 400 },
    );
  }
  // Unknowns rejected above, so every `code` is a narrowed PurposeCode here.
  const purposeCodes = Array.from(
    new Set(normalized.map((n) => n.code as PurposeCode)),
  );

  // Cross-org check: caller must be recording consent for an actual
  // member of this org.
  const member = await prisma.membership.findUnique({
    where: {
      userId_organizationId: { userId: body.userId, organizationId: orgId },
    },
    select: { id: true },
  });
  if (!member) {
    return NextResponse.json(
      { error: "User is not a member of this organization" },
      { status: 404 },
    );
  }

  const draft = buildConsentArtifact({
    userId: body.userId,
    dataFiduciary: orgDataFiduciary(orgId),
    purposeCodes,
    language: body.language,
    consentManager: body.consentManager ?? null,
    version: body.version,
  });

  const [consent] = await prisma.$transaction([
    prisma.consentArtifact.create({ data: draft }),
    prisma.orgAuditLog.create({
      data: {
        organizationId: orgId,
        actorMembershipId: access.member.id,
        targetMembershipId: member.id,
        category: "CONSENT",
        action: AUDIT_ACTIONS.CONSENT.CONSENT_GRANTED,
        // PII hygiene (DPDP §8, §11): do NOT spell out the data
        // principal's userId in the description — audit-log descriptions
        // are surfaced in the admin UI and exported via CSV/SIEM, which
        // widens the blast radius for a PII leak. The targetMembershipId
        // column already connects this log back to the exact member, and
        // `details` is a structured JSON blob that auditors can pivot on
        // without splashing the id in free text.
        description: `Consent granted for member ${member.id}`,
        details: {
          membershipId: member.id,
          purposeCodes,
          language: body.language,
          version: body.version,
          hash: draft.hash,
        },
      },
    }),
  ]);

  return NextResponse.json({ consent }, { status: 201 });
}

/**
 * DELETE /api/organizations/[orgId]/consent?purposeCode=<code>[&userId=<self>]
 *
 * The member withdraws their OWN consent for one purpose: stamps
 * `withdrawnAt=now()` on their active ConsentArtifacts carrying it.
 *
 *  - Withdrawal is irreversible in our model: a subsequent "re-grant"
 *    goes through `POST` and produces a NEW artifact with a fresh hash.
 *    That keeps the chain-of-custody intact for DPDP auditors.
 *
 *  - `purposeCode` is required. The consent table has no org column, so a
 *    withdrawal here is platform-wide; an omitted code must not silently
 *    become a withdraw-all through an org route.
 *
 *  - #1527 decision 5 — only the member withdraws (CONSENT_WITHDRAW_SELF_ONLY
 *    for anyone else). Operators record a withdrawal request instead
 *    (./withdrawal-requests), which the member sees in Account settings.
 */
const DeleteQuerySchema = z.object({
  userId: z.string().min(1).max(128).optional(),
  purposeCode: z.string().min(1).max(64),
});

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const access = await requireOrgAccess(orgId);
  if (access.error) return access.error;

  const url = new URL(req.url);
  const parsed = DeleteQuerySchema.safeParse(
    Object.fromEntries(url.searchParams.entries()),
  );
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid query", detail: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const userId = parsed.data.userId ?? access.session.user.id;
  if (userId !== access.session.user.id) {
    return NextResponse.json(
      {
        error:
          "Only the member can withdraw their own consent. Record a withdrawal request instead.",
        code: "CONSENT_WITHDRAW_SELF_ONLY",
      },
      { status: 403 },
    );
  }
  // Normalise a legacy kebab-case scope to canonical so a withdrawal targets
  // the same code the gate/storage uses (e.g. third-party-sharing-with-stream
  // → STREAM_DATA_PROCESSING). An unknown code must 400 — NOT fall back to
  // undefined, which `withdrawConsent` reads as "withdraw ALL consents".
  const purposeCode = normalizePurposeCode(parsed.data.purposeCode);
  if (purposeCode === undefined) {
    return NextResponse.json(
      {
        error: "Unknown purpose code",
        detail: { purposeCode: parsed.data.purposeCode },
      },
      { status: 400 },
    );
  }

  // Cross-org guard: same logic as POST — only members of this org can
  // withdraw through this endpoint.
  const member = await prisma.membership.findUnique({
    where: {
      userId_organizationId: { userId, organizationId: orgId },
    },
    select: { id: true },
  });
  if (!member) {
    return NextResponse.json(
      { error: "User is not a member of this organization" },
      { status: 404 },
    );
  }

  try {
    const { withdrawnCount } = await prisma.$transaction(async (tx) => {
      const result = await withdrawConsent({ userId, purposeCode }, tx);
      if (result.withdrawnCount > 0) {
        await tx.orgAuditLog.create({
          data: {
            organizationId: orgId,
            actorMembershipId: access.member.id,
            targetMembershipId: member.id,
            category: "CONSENT",
            action: AUDIT_ACTIONS.CONSENT.CONSENT_WITHDRAWN,
            // Same PII-hygiene rule as CONSENT_GRANTED: no raw userId
            // in the description; the membership FK is the pivot.
            description: `Consent withdrawn (purpose=${purposeCode}) for member ${member.id}`,
            details: {
              membershipId: member.id,
              purposeCode,
              withdrawnCount: result.withdrawnCount,
            },
          },
        });
      }
      return result;
    });

    return NextResponse.json({ withdrawnCount });
  } catch (err) {
    Sentry.captureException(
      err instanceof Error ? err : new Error(String(err)),
      { tags: { subsystem: "enterprise" } },
    );
    console.error("[consent DELETE] withdrawal transaction failed", err);
    return NextResponse.json(
      { error: "Failed to withdraw consent" },
      { status: 500 },
    );
  }
}
