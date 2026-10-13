/**
 * GET /api/organizations/[orgId]/webhooks/[endpointId]/deliveries
 *
 * Paginated delivery log. integrations.manage — the same grant as the
 * endpoint list because the delivery body itself can carry PII (the
 * original event payload mirrors the route that triggered it).
 */

import { NextResponse, type NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";
import { hasOrgPermission } from "@/lib/auth/org-permissions";
import { MEMBER_DATA_WEBHOOK_EVENTS } from "@/lib/enterprise/outbound-webhooks/event-types";

export async function GET(
  req: NextRequest,
  {
    params,
  }: {
    params: Promise<{ orgId: string; endpointId: string }>;
  },
) {
  const { orgId, endpointId } = await params;
  // #1527 P0-4 — the same grant as the Webhooks tab and the writes (OWNER +
  // BILLING_ADMIN); was a MANAGER rank floor.
  const access = await requireOrgAccess(orgId, {
    readOnly: true,
    permission: "integrations.manage",
  });
  if (access.error) return access.error;

  // Verify the endpoint belongs to this org BEFORE touching the
  // delivery table — otherwise a guessed endpointId from a sibling
  // org would leak that org's delivery payloads.
  const endpoint = await prisma.webhookEndpoint.findFirst({
    where: { id: endpointId, organizationId: orgId },
    select: { id: true },
  });
  if (!endpoint) {
    return NextResponse.json(
      { error: "Webhook endpoint not found" },
      { status: 404 },
    );
  }

  const url = new URL(req.url);
  const page = Math.max(1, Number(url.searchParams.get("page") ?? 1));
  const perPage = Math.min(
    100,
    Math.max(1, Number(url.searchParams.get("perPage") ?? 25)),
  );

  // #1851 decision 11 — member-event payloads are member data; without
  // webhooks.subscribe.memberEvents (BILLING_ADMIN) those rows never show.
  const where = hasOrgPermission(
    access.member.role,
    "webhooks.subscribe.memberEvents",
  )
    ? { webhookEndpointId: endpointId }
    : {
        webhookEndpointId: endpointId,
        eventType: { notIn: [...MEMBER_DATA_WEBHOOK_EVENTS] },
      };

  const [total, deliveries] = await prisma.$transaction([
    prisma.outboundWebhookDelivery.count({ where }),
    prisma.outboundWebhookDelivery.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * perPage,
      take: perPage,
      select: {
        id: true,
        eventType: true,
        status: true,
        httpStatusCode: true,
        attempts: true,
        nextRetryAt: true,
        lastError: true,
        createdAt: true,
        deliveredAt: true,
        // Payload is intentionally included — operators need it to
        // diagnose receiver-side parse failures. integrations.manage is
        // the gate; without it the row is not readable.
        payload: true,
      },
    }),
  ]);

  return NextResponse.json({
    data: deliveries,
    meta: { total, page, perPage },
  });
}
