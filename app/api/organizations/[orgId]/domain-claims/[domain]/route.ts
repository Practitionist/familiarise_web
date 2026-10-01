/**
 * DELETE /api/organizations/[orgId]/domain-claims/[domain]
 *
 * Releases a previously-claimed domain. The URL path uses the domain
 * string directly (after URI-decode) rather than the row uuid, so an
 * admin can hit `DELETE .../domain-claims/wipro.com` without first having
 * to look up the row id.
 */

import * as Sentry from "@sentry/nextjs";
import { NextResponse, type NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";

export async function DELETE(
  _req: NextRequest,
  {
    params,
  }: {
    params: Promise<{ orgId: string; domain: string }>;
  },
) {
  const { orgId, domain: rawDomain } = await params;
  const domain = decodeURIComponent(rawDomain).toLowerCase().trim();
  const access = await requireOrgAccess(orgId, {
    permission: "identity.manage",
  });
  if (access.error) return access.error;

  try {
    await prisma.$transaction(async (tx) => {
      const claim = await tx.orgDomainClaim.findUnique({
        where: { domain },
      });
      if (!claim || claim.organizationId !== orgId) {
        throw Object.assign(new Error("Domain claim not found"), {
          httpStatus: 404,
        });
      }

      await tx.orgDomainClaim.delete({ where: { domain } });

      await tx.orgAuditLog.create({
        data: {
          organizationId: orgId,
          actorMembershipId: access.member.id,
          category: "SETTINGS",
          action: AUDIT_ACTIONS.SETTINGS.DOMAIN_RELEASED,
          description: `Domain '${domain}' released`,
          details: { domain },
        },
      });
    });

    return new NextResponse(null, { status: 204 });
  } catch (err) {
    if (err instanceof Error && "httpStatus" in err) {
      const status = typeof err.httpStatus === "number" ? err.httpStatus : 500;
      return NextResponse.json({ error: err.message }, { status });
    }
    Sentry.captureException(
      err instanceof Error ? err : new Error(String(err)),
      { tags: { subsystem: "organizations" } },
    );
    throw err;
  }
}
