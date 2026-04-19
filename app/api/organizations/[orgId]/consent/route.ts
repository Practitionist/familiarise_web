/**
 * GET  /api/organizations/[orgId]/consent
 * POST /api/organizations/[orgId]/consent
 *
 * DPDP (India) consent-artifact surface, scoped to an org. Consent records
 * live on the global `ConsentArtifact` table — the org scope here filters
 * to artifacts granted by members of this organization, which gives admins
 * a compliance-dashboard view without exposing other orgs' records.
 *
 * POST writes a tamper-evident consent row via `buildConsentArtifact`
 * (lib/compliance/dpdp.ts). The SHA-256 hash is real; the surrounding
 * consent-manager + notice-versioning workflow is documented in the dpdp
 * stub header.
 *
 * Retention: `auditRetainedUntil` = grantedAt + 7y per DPDP Rules (Nov
 * 2025). A daily cron sweeper (jobs/compliance/consent-retention-sweeper)
 * purges expired rows — this endpoint does NOT delete.
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";
import { buildConsentArtifact } from "@/lib/compliance/dpdp";

// Schedule VIII of the Indian Constitution enumerates 22 languages.
// Plus English as the lingua franca for enterprise UIs. Accept ISO 639-1
// codes here; the language-label mapping lives client-side.
const LanguageSchema = z
  .string()
  .min(2)
  .max(10)
  .regex(/^[a-z]{2,3}(-[A-Z]{2})?$/, "ISO 639-1/2 language code required");

const CreateBodySchema = z.object({
  userId: z.string().uuid(),
  purposeCodes: z.array(z.string().min(1).max(64)).min(1).max(20),
  language: LanguageSchema,
  consentManager: z.string().min(1).max(120).nullable().optional(),
  version: z.coerce.number().int().min(1),
});

const QuerySchema = z.object({
  userId: z.string().uuid().optional(),
  active: z.enum(["true", "false"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const access = await requireOrgAccess(orgId, "MANAGER");
  if (access.error) return access.error;

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

  // Scope to this org: fetch member userIds once, then filter consents.
  // Without this filter an admin could see consent rows for users in
  // other orgs, which defeats the point of org-scoped dashboards.
  const memberUserIds = await prisma.membership.findMany({
    where: { organizationId: orgId },
    select: { userId: true },
  });
  const orgUserIds = memberUserIds.map((m) => m.userId);
  if (orgUserIds.length === 0) {
    return NextResponse.json({ data: [] });
  }

  const consents = await prisma.consentArtifact.findMany({
    where: {
      userId: q.userId ? q.userId : { in: orgUserIds },
      ...(q.userId && !orgUserIds.includes(q.userId)
        ? { id: "__no_match__" } // short-circuit: requested user not in org
        : {}),
      ...(q.active === "true" && { withdrawnAt: null }),
      ...(q.active === "false" && { withdrawnAt: { not: null } }),
    },
    orderBy: { grantedAt: "desc" },
    take: q.limit,
  });

  return NextResponse.json({ data: consents });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const access = await requireOrgAccess(orgId, "MANAGER");
  if (access.error) return access.error;

  const raw = await req.json().catch(() => null);
  const parsed = CreateBodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body", detail: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const body = parsed.data;

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
    dataFiduciary: `org:${orgId}`,
    purposeCodes: body.purposeCodes,
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
        description: `Consent granted for user ${body.userId}`,
        details: {
          purposeCodes: body.purposeCodes,
          language: body.language,
          version: body.version,
          hash: draft.hash,
        },
      },
    }),
  ]);

  return NextResponse.json({ consent }, { status: 201 });
}
