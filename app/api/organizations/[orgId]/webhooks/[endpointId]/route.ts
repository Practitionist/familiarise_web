/**
 * GET    /api/organizations/[orgId]/webhooks/[endpointId]
 * PATCH  /api/organizations/[orgId]/webhooks/[endpointId]
 * DELETE /api/organizations/[orgId]/webhooks/[endpointId]
 *
 * Detail + mutation routes for a single webhook endpoint. PATCH allows
 * editing the URL, event subscriptions, and status (ACTIVE / PAUSED /
 * DISABLED) — OWNER + BILLING_ADMIN. DELETE is OWNER-only because
 * removing an endpoint while deliveries are mid-retry would orphan
 * those rows (they'd cascade-delete via the FK).
 */

import * as Sentry from "@sentry/nextjs";
import { NextResponse, type NextRequest } from "next/server";
import type { MemberRole } from "@prisma/client";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";
import {
  OUTBOUND_WEBHOOK_EVENTS,
  carriesMemberData,
  isOutboundWebhookEvent,
} from "@/lib/enterprise/outbound-webhooks/event-types";
import { hasOrgPermission } from "@/lib/auth/org-permissions";
import { applyRateLimit, orgWebhookLimiter } from "@/lib/rate-limit";
import { rejectIfNotPublicUrl } from "@/lib/enterprise/outbound-webhooks/ssrf-guard";

const REDACTED_SECRET = "[redacted]";

const HttpsUrl = z
  .string()
  .url()
  .refine((u) => u.startsWith("https://"), {
    message: "Webhook URL must use https://",
  })
  .refine((u) => u.length <= 2048, {
    message: "Webhook URL must be ≤2048 characters",
  });

const PatchBodySchema = z.object({
  url: HttpsUrl.optional(),
  status: z.enum(["ACTIVE", "PAUSED", "DISABLED"]).optional(),
  eventSubscriptions: z
    .array(z.string())
    .min(1)
    .refine((arr) => arr.every(isOutboundWebhookEvent), {
      message: `Unknown event type. Allowed: ${OUTBOUND_WEBHOOK_EVENTS.join(", ")}`,
    })
    .optional(),
});

export async function GET(
  _req: NextRequest,
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
    permission: "integrations.manage",
  });
  if (access.error) return access.error;

  const endpoint = await prisma.webhookEndpoint.findFirst({
    where: { id: endpointId, organizationId: orgId },
    select: {
      id: true,
      url: true,
      status: true,
      eventSubscriptions: true,
      failureCount: true,
      lastSuccessAt: true,
      lastFailureAt: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  if (!endpoint) {
    return NextResponse.json(
      { error: "Webhook endpoint not found" },
      { status: 404 },
    );
  }
  return NextResponse.json({
    endpoint: { ...endpoint, secret: REDACTED_SECRET },
  });
}

/**
 * #1851 decision 11 — an endpoint carrying member events is the OWNER's:
 * repointing its URL would route member data to whoever edits it.
 */
function assertMayEditMemberEndpoint(
  role: MemberRole,
  current: readonly string[],
  next: readonly string[] | undefined,
): void {
  if (
    (carriesMemberData(current) || carriesMemberData(next ?? [])) &&
    !hasOrgPermission(role, "webhooks.subscribe.memberEvents")
  ) {
    throw Object.assign(
      new Error(
        "Only an Owner can change a webhook that carries member events.",
      ),
      { httpStatus: 403, code: "WEBHOOK_MEMBER_EVENTS_OWNER_ONLY" },
    );
  }
}

/** A typed refusal thrown inside the transaction, as a response. */
function refusalResponse(err: unknown): NextResponse | null {
  if (!(err instanceof Error) || !("httpStatus" in err)) return null;
  const code =
    "code" in err && typeof err.code === "string" ? err.code : undefined;
  return NextResponse.json(
    { error: err.message, ...(code && { code }) },
    { status: (err as { httpStatus?: number }).httpStatus ?? 500 },
  );
}

export async function PATCH(
  req: NextRequest,
  {
    params,
  }: {
    params: Promise<{ orgId: string; endpointId: string }>;
  },
) {
  const { orgId, endpointId } = await params;
  const access = await requireOrgAccess(orgId, {
    permission: "integrations.manage",
  });
  if (access.error) return access.error;

  const rl = await applyRateLimit(orgWebhookLimiter, `org:${orgId}`);
  if (rl) return rl;

  const raw = await req.json().catch(() => null);
  const parsed = PatchBodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body", detail: parsed.error.flatten() },
      { status: 400 },
    );
  }
  if (Object.keys(parsed.data).length === 0) {
    // Reject empty-PATCH explicitly so the audit log never carries a
    // "no-op" row. An accidental empty body is almost always a bug in
    // the caller.
    return NextResponse.json(
      { error: "No mutable fields in body" },
      { status: 400 },
    );
  }

  // #1132 — a PATCH can repoint an existing endpoint at an internal address,
  // so the egress guard has to run here too, not only on create.
  if (parsed.data.url !== undefined) {
    const blocked = await rejectIfNotPublicUrl(parsed.data.url);
    if (blocked) return blocked;
  }

  let updated;
  try {
    updated = await prisma.$transaction(async (tx) => {
      const current = await tx.webhookEndpoint.findFirst({
        where: { id: endpointId, organizationId: orgId },
      });
      if (!current) {
        throw Object.assign(new Error("Webhook endpoint not found"), {
          httpStatus: 404,
        });
      }
      assertMayEditMemberEndpoint(
        access.member.role,
        current.eventSubscriptions,
        parsed.data.eventSubscriptions,
      );
      const next = await tx.webhookEndpoint.update({
        where: { id: endpointId },
        data: {
          ...(parsed.data.url !== undefined && { url: parsed.data.url }),
          ...(parsed.data.status !== undefined && {
            status: parsed.data.status,
          }),
          ...(parsed.data.eventSubscriptions !== undefined && {
            eventSubscriptions: parsed.data.eventSubscriptions,
          }),
        },
      });
      await tx.orgAuditLog.create({
        data: {
          organizationId: orgId,
          actorMembershipId: access.member.id,
          category: "WEBHOOK",
          action:
            parsed.data.status === "PAUSED"
              ? AUDIT_ACTIONS.WEBHOOK.WEBHOOK_ENDPOINT_PAUSED
              : parsed.data.status === "ACTIVE" && current.status !== "ACTIVE"
                ? AUDIT_ACTIONS.WEBHOOK.WEBHOOK_ENDPOINT_RESUMED
                : AUDIT_ACTIONS.WEBHOOK.WEBHOOK_ENDPOINT_UPDATED,
          description: `Updated webhook endpoint ${next.url}`,
          details: {
            endpointId,
            changedFields: Object.keys(parsed.data),
            fromStatus: current.status,
            toStatus: next.status,
          },
        },
      });
      return next;
    });
  } catch (err) {
    // The 404 and the member-events 403 are thrown inside the transaction so
    // the check reads the same row the update writes.
    const refused = refusalResponse(err);
    if (refused) return refused;
    throw err;
  }

  return NextResponse.json({
    endpoint: {
      id: updated.id,
      url: updated.url,
      status: updated.status,
      eventSubscriptions: updated.eventSubscriptions,
      secret: REDACTED_SECRET,
      updatedAt: updated.updatedAt,
    },
  });
}

export async function DELETE(
  _req: NextRequest,
  {
    params,
  }: {
    params: Promise<{ orgId: string; endpointId: string }>;
  },
) {
  const { orgId, endpointId } = await params;
  // Why OWNER-only (not BILLING_ADMIN): deletion cascades to every
  // pending/retrying delivery row (`onDelete: Cascade` on the FK). An
  // org that's actively integrating with a third-party would lose all
  // in-flight events on a single misclick. Restrict to OWNER so the
  // action requires deliberate elevation.
  const access = await requireOrgAccess(orgId, {
    permission: "webhooks.delete",
  });
  if (access.error) return access.error;

  try {
    await prisma.$transaction(async (tx) => {
      const current = await tx.webhookEndpoint.findFirst({
        where: { id: endpointId, organizationId: orgId },
      });
      if (!current) {
        throw Object.assign(new Error("Webhook endpoint not found"), {
          httpStatus: 404,
        });
      }
      await tx.webhookEndpoint.delete({ where: { id: endpointId } });
      await tx.orgAuditLog.create({
        data: {
          organizationId: orgId,
          actorMembershipId: access.member.id,
          category: "WEBHOOK",
          action: AUDIT_ACTIONS.WEBHOOK.WEBHOOK_ENDPOINT_DELETED,
          description: `Deleted webhook endpoint ${current.url}`,
          details: { endpointId, url: current.url },
        },
      });
    });
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    if (err instanceof Error && "httpStatus" in err) {
      return NextResponse.json(
        { error: err.message },
        { status: (err as { httpStatus?: number }).httpStatus ?? 500 },
      );
    }
    Sentry.captureException(
      err instanceof Error ? err : new Error(String(err)),
      { tags: { subsystem: "enterprise" } },
    );
    throw err;
  }
}
