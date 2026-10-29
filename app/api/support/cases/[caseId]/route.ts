import { hasBackofficePermission } from "@/lib/auth/backoffice-permissions";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireApiAuth, requireBackofficeSurface } from "@/lib/auth-helpers";
import { parseRouteParams, supportError } from "@/lib/api/support-http";
import prisma from "@/lib/prisma";
import { caseThreadPartyIds } from "@/lib/support/case-access";
import { stageExternalRequesterEmail } from "@/lib/support/external-requester";
import { notifySupportTicketUpdate } from "@/lib/novu";
import { flushNotificationsAfter } from "@/lib/novu/stage-then-attempt";
import { notificationScope } from "@/lib/novu/workflows";
import { supportTicketStatusLabel } from "@/lib/novu/humanize";
import { supportRequestHref } from "@/lib/novu/resolve-href";
import { caseKeyOf } from "@/lib/support/case-key";
import { stageSupportTicketUpdateEmail } from "@/lib/email/senders/people";
import {
  PatchSupportCaseSchema,
  patchSupportCaseLifecycle,
  readSupportCaseForViewer,
} from "@/lib/support/case-service";
import { sessionRole } from "@/lib/auth/session-role";
import { isFreshSession } from "@/lib/auth/step-up";

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
      isStaff: hasBackofficePermission(
        sessionRole(user.role),
        "tickets.manage",
      ),
      role: sessionRole(user.role),
      canReadPayments: hasBackofficePermission(
        sessionRole(user.role),
        "payments.read",
      ),
      canReadContact: hasBackofficePermission(
        sessionRole(user.role),
        "users.read",
      ),
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
    const auth = await requireBackofficeSurface("tickets.manage");
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

    if (
      parsed.data.legalHold !== undefined &&
      sessionRole(auth.session.user.role) !== "ADMIN"
    )
      return NextResponse.json(
        {
          error: "Only an admin can place or lift a legal hold.",
          code: "FORBIDDEN",
        },
        { status: 403 },
      );

    const result = await patchSupportCaseLifecycle(
      { ...parsed.data, caseId, actorId },
      new Date(),
      {
        actorRole: String(auth.session.user.role ?? "UNKNOWN"),
        freshSession: isFreshSession(auth.session.session),
      },
    );

    if (!result.ok) {
      const { ok: _ok, status, ...body } = result;
      return NextResponse.json(body, { status });
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
          ]
        : [];

    if (statusTargets.length > 0) {
      const batches = await Promise.all(
        statusTargets.map(async (t) => {
          const current = await prisma.supportCase.findUnique({
            where: { id: t.id },
          });
          if (!current) return [];
          const statusLabel = supportTicketStatusLabel(t.status);
          if (current.externalRequesterEmail) {
            const email = await stageExternalRequesterEmail({
              caseId: t.id,
              reference: t.referenceNumber,
              to: current.externalRequesterEmail,
              subject: `Support update — ${t.referenceNumber}`,
              text: `Reference: ${t.referenceNumber}. Status: ${statusLabel}.`,
              emailType: "SUPPORT_TICKET_UPDATE",
              entityRef: `case-status:${t.id}:${t.status}:${t.updatedAtMs}`,
            });
            return [{ stagedBell: null, emailRows: [email] }];
          }
          const recipients = await caseThreadPartyIds(current);
          const dashboardUrl = supportRequestHref(
            caseKeyOf({ kind: "case", id: t.id }),
            t.organizationId,
          );
          return Promise.all(
            recipients.map(async (recipientId) => {
              const [bellResult, emailRows] = await Promise.all([
                notifySupportTicketUpdate(
                  recipientId,
                  {
                    ticketId: t.id,
                    reference: t.referenceNumber,
                    ticketTitle: t.title,
                    status: statusLabel,
                    statusCode: t.status,
                    dashboardUrl,
                    ...notificationScope(t.organizationId),
                  },
                  `case-status:${t.id}:${t.status}:${t.updatedAtMs}:${recipientId}`,
                  { deferAttempt: true },
                ),
                stageSupportTicketUpdateEmail(prisma, {
                  ticketId: t.id,
                  ownerUserId: recipientId,
                  reference: t.referenceNumber,
                  title:
                    current.ownershipScope === "PERSONAL"
                      ? t.title
                      : "Organization support request",
                  statusCode:
                    t.status === "ESCALATED" ? "IN_PROGRESS" : t.status,
                  statusLabel,
                  ticketUrl: dashboardUrl,
                }),
              ]);
              return { stagedBell: bellResult?.staged ?? null, emailRows };
            }),
          );
        }),
      );
      const stagedResults = batches.flat();
      await flushNotificationsAfter(
        {
          bells: stagedResults.flatMap((r) =>
            r.stagedBell ? [r.stagedBell] : [],
          ),
          emails: stagedResults.map((r) => ({
            rows: r.emailRows,
            emailType: "SUPPORT_TICKET_UPDATE",
          })),
        },
        "support.case.patch",
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
