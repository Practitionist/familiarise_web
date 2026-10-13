import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  isPrivileged,
  requireApiAuth,
  requirePrivilegedAuth,
} from "@/lib/auth-helpers";
import { parseRouteParams, supportError } from "@/lib/api/support-http";
import { notifySupportTicketUpdate } from "@/lib/novu";
import { notificationScope } from "@/lib/novu/workflows";
import { supportTicketStatusLabel } from "@/lib/novu/humanize";
import { supportRequestHref } from "@/lib/novu/resolve-href";
import { caseKeyOf } from "@/lib/support/case-key";
import { EMAIL_BUDGET_MS, sendSupportTicketUpdateEmail } from "@/lib/email";
import {
  PatchSupportCaseSchema,
  patchSupportCaseLifecycle,
  readSupportCaseForViewer,
} from "@/lib/support/case-service";

const CaseIdParamsSchema = z.object({
  caseId: z.string().min(1).max(64),
});

const PatchCaseBodySchema = PatchSupportCaseSchema.omit({
  caseId: true,
  actorId: true,
});

interface RouteParams {
  params: Promise<{ caseId: string }>;
}

export async function GET(_req: NextRequest, { params }: RouteParams) {
  const id = await parseRouteParams(CaseIdParamsSchema, params, {
    route: "support.case.detail",
  });
  if (!id.ok) return id.response;
  const { caseId } = id.data;

  try {
    const auth = await requireApiAuth();
    if (auth.error) return auth.error;
    const { user } = auth.session;

    const view = await readSupportCaseForViewer(caseId, {
      userId: user.id,
      isStaff: isPrivileged(user.role),
    });

    if (!view) {
      return NextResponse.json(
        { error: "Support case not found" },
        { status: 404 },
      );
    }

    return NextResponse.json({ data: view });
  } catch (cause) {
    return supportError({
      status: 500,
      code: "INTERNAL",
      cause,
      context: { route: "support.case.detail", action: "get", caseId },
    });
  }
}

export async function PATCH(req: NextRequest, { params }: RouteParams) {
  const id = await parseRouteParams(CaseIdParamsSchema, params, {
    route: "support.case.detail",
  });
  if (!id.ok) return id.response;
  const { caseId } = id.data;

  try {
    const auth = await requirePrivilegedAuth();
    if (auth.error) return auth.error;
    const actorId = auth.session.user.id;

    const parsed = PatchCaseBodySchema.safeParse(
      await req.json().catch(() => null),
    );
    if (!parsed.success) {
      return supportError({
        status: 400,
        code: "VALIDATION_FAILED",
        detail: parsed.error.flatten(),
        context: { route: "support.case.detail", action: "patch", caseId },
      });
    }

    const result = await patchSupportCaseLifecycle({
      ...parsed.data,
      caseId,
      actorId,
    });

    if (!result.ok) {
      return NextResponse.json(
        { error: result.error, code: result.code },
        { status: result.status },
      );
    }

    const updatedCase = result.supportCase;
    const statusTargets =
      result.previousStatus !== updatedCase.status
        ? [
            {
              id: updatedCase.id,
              referenceNumber: updatedCase.referenceNumber,
              title: updatedCase.title,
              status: updatedCase.status,
              submitterUserId: updatedCase.submitterUserId,
              organizationId: updatedCase.organizationId,
              updatedAtMs: updatedCase.updatedAt.getTime(),
            },
            ...(result.cascadedIncidents ?? []).map((inc) => ({
              id: inc.id,
              referenceNumber: inc.referenceNumber,
              title: inc.title,
              status: "RESOLVED" as const,
              submitterUserId: inc.submitterUserId,
              organizationId: inc.organizationId,
              updatedAtMs: updatedCase.updatedAt.getTime(),
            })),
          ]
        : [];

    if (statusTargets.length > 0) {
      await Promise.all(
        statusTargets.flatMap((t) => {
          const statusLabel = supportTicketStatusLabel(t.status);
          const dashboardUrl = supportRequestHref(
            caseKeyOf({ kind: "case", id: t.id }),
            t.organizationId,
          );
          return [
            notifySupportTicketUpdate(
              t.submitterUserId,
              {
                ticketId: t.id,
                reference: t.referenceNumber,
                ticketTitle: t.title,
                status: statusLabel,
                statusCode: t.status,
                dashboardUrl,
                ...notificationScope(t.organizationId),
              },
              `case-status:${t.id}:${t.status}:${t.updatedAtMs}`,
            ).catch(() => undefined),
            sendSupportTicketUpdateEmail(
              {
                ticketId: t.id,
                ownerUserId: t.submitterUserId,
                reference: t.referenceNumber,
                title: t.title,
                statusCode: t.status === "ESCALATED" ? "IN_PROGRESS" : t.status,
                statusLabel,
                ticketUrl: dashboardUrl,
              },
              EMAIL_BUDGET_MS.REQUEST,
            ).catch(() => undefined),
          ];
        }),
      );
    }

    return NextResponse.json({ data: updatedCase });
  } catch (cause) {
    return supportError({
      status: 500,
      code: "INTERNAL",
      cause,
      context: { route: "support.case.detail", action: "patch", caseId },
    });
  }
}
