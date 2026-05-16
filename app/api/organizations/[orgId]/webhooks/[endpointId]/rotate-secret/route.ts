/**
 * POST /api/organizations/[orgId]/webhooks/[endpointId]/rotate-secret
 *
 * Mints a fresh 32-byte secret for the endpoint and returns it ONCE.
 * The previous secret is overwritten immediately — any in-flight
 * delivery still using the old signature will be rejected by the
 * receiver. Use case: a leaked secret, or rotation hygiene on a
 * compliance schedule.
 *
 * OWNER-only on purpose — rotating the secret is destructive from the
 * integrator's perspective (their verification code stops working
 * until they update the env var), so we want the gate to be the
 * highest-trust role. BILLING_ADMIN can pause/disable but not rotate.
 */

import { NextResponse, type NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import { requireOrgOwner } from "@/lib/auth-helpers";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";
import { generateEndpointSecret } from "@/lib/enterprise/outbound-webhooks/signing";
import { applyRateLimit, orgWebhookLimiter } from "@/lib/rate-limit";

export async function POST(
  _req: NextRequest,
  {
    params,
  }: {
    params: Promise<{ orgId: string; endpointId: string }>;
  },
) {
  const { orgId, endpointId } = await params;
  const access = await requireOrgOwner(orgId);
  if (access.error) return access.error;

  const rl = await applyRateLimit(orgWebhookLimiter, `org:${orgId}`);
  if (rl) return rl;

  const newSecret = generateEndpointSecret();

  try {
    const updated = await prisma.$transaction(async (tx) => {
      const current = await tx.webhookEndpoint.findFirst({
        where: { id: endpointId, organizationId: orgId },
      });
      if (!current) {
        throw Object.assign(new Error("Webhook endpoint not found"), {
          httpStatus: 404,
        });
      }
      const next = await tx.webhookEndpoint.update({
        where: { id: endpointId },
        data: { secret: newSecret },
      });
      await tx.orgAuditLog.create({
        data: {
          organizationId: orgId,
          actorMembershipId: access.member.id,
          category: "WEBHOOK",
          action: AUDIT_ACTIONS.WEBHOOK.WEBHOOK_SECRET_ROTATED,
          description: `Rotated secret for webhook endpoint ${current.url}`,
          details: { endpointId, url: current.url },
        },
      });
      return next;
    });

    return NextResponse.json({
      endpoint: {
        id: updated.id,
        url: updated.url,
        status: updated.status,
        secret: newSecret,
        updatedAt: updated.updatedAt,
      },
    });
  } catch (err) {
    if (err instanceof Error && "httpStatus" in err) {
      return NextResponse.json(
        { error: err.message },
        { status: (err as { httpStatus?: number }).httpStatus ?? 500 },
      );
    }
    throw err;
  }
}
