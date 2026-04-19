/**
 * GET  /api/organizations/[orgId]/domain-claims
 * POST /api/organizations/[orgId]/domain-claims
 *
 * An OrgDomainClaim maps an email domain (e.g. `wipro.com`) to a single
 * organization, enabling domain-based auto-join during SSO login and
 * invitation flows. Domains are globally unique — two orgs cannot both
 * claim the same domain, since that would make domain→org resolution
 * ambiguous at login time.
 *
 * Verification-of-ownership for claimed domains is deliberately out of
 * scope here; we expect an OWNER-only flow and trust owner intent. Future
 * work: DNS TXT verification before activating a claim.
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { requireOrgAccess, requireOrgOwner } from "@/lib/auth-helpers";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";

const DOMAIN_REGEX =
  /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i;

const CreateBodySchema = z.object({
  domain: z
    .string()
    .trim()
    .toLowerCase()
    .min(3)
    .max(253)
    .regex(DOMAIN_REGEX, "Invalid domain format"),
});

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const access = await requireOrgAccess(orgId, "MANAGER");
  if (access.error) return access.error;

  const claims = await prisma.orgDomainClaim.findMany({
    where: { organizationId: orgId },
    orderBy: { claimedAt: "desc" },
  });

  return NextResponse.json({ data: claims });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const access = await requireOrgOwner(orgId);
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

  try {
    const created = await prisma.$transaction(async (tx) => {
      const existing = await tx.orgDomainClaim.findUnique({
        where: { domain: body.domain },
        include: { organization: { select: { id: true, name: true } } },
      });
      if (existing) {
        const mine = existing.organizationId === orgId;
        throw Object.assign(
          new Error(
            mine
              ? `Domain '${body.domain}' is already claimed by this organization`
              : `Domain '${body.domain}' is already claimed by another organization`,
          ),
          { httpStatus: 409 },
        );
      }

      const claim = await tx.orgDomainClaim.create({
        data: {
          organizationId: orgId,
          domain: body.domain,
        },
      });

      await tx.orgAuditLog.create({
        data: {
          organizationId: orgId,
          actorMembershipId: access.member.id,
          category: "SETTINGS",
          action: AUDIT_ACTIONS.SETTINGS.DOMAIN_CLAIMED,
          description: `Domain '${body.domain}' claimed`,
          details: { domain: body.domain, claimId: claim.id },
        },
      });

      return claim;
    });

    return NextResponse.json({ domainClaim: created }, { status: 201 });
  } catch (err) {
    if (err instanceof Error && "httpStatus" in err) {
      const status =
        typeof err.httpStatus === "number" ? err.httpStatus : 500;
      return NextResponse.json({ error: err.message }, { status });
    }
    throw err;
  }
}
