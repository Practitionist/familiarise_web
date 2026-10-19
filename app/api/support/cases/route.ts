import {
  visibleCaseWhere,
  caseOwnershipPermission,
} from "@/lib/support/case-access";
import { hasOrgPermission } from "@/lib/auth/org-permissions";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { MemberRole } from "@prisma/client";
import prisma from "@/lib/prisma";
import { requireApiAuth } from "@/lib/auth-helpers";
import { hasBackofficePermission } from "@/lib/auth/backoffice-permissions";
import { spamLimiter, applyRateLimit } from "@/lib/rate-limit";
import { assertBodySize } from "@/lib/validation/limits";
import { supportError } from "@/lib/api/support-http";
import {
  CreateSupportCaseObjectSchema,
  SupportCaseStatusSchema,
  SupportCaseValidationError,
  createOrReuseSupportCase,
  readSupportCaseForViewer,
  refineCreateSupportCaseInput,
} from "@/lib/support/case-service";

const ALLOWED_ORG_SUBMITTER_ROLES: ReadonlySet<MemberRole> = new Set([
  "OWNER",
  "MAINTAINER",
]);

const StaffCreateCaseBodySchema = CreateSupportCaseObjectSchema.omit({
  submitterUserId: true,
  initialSender: true,
  initialAuthorUserId: true,
})
  .extend({
    requesterUserId: z.string().min(1).max(64).optional(),
    paymentId: z.string().min(1).max(64).optional(),
  })
  .superRefine(refineCreateSupportCaseInput);

const ClientCreateCaseBodySchema = CreateSupportCaseObjectSchema.omit({
  submitterUserId: true,
  initialSender: true,
  initialAuthorUserId: true,
  caseKind: true,
  problemCaseId: true,
  subjects: true,
  priority: true,
  activeChannel: true,
  currentNodeId: true,
  flowKey: true,
})
  .extend({
    requesterUserId: z.string().min(1).max(64).optional(),
    paymentId: z.string().min(1).max(64).optional(),
  })
  .superRefine(refineCreateSupportCaseInput);

type ParsedCaseCreationBody = z.infer<typeof StaffCreateCaseBodySchema>;

export async function GET(req: NextRequest) {
  try {
    const auth = await requireApiAuth();
    if (auth.error) return auth.error;
    const { user } = auth.session;
    const staff = hasBackofficePermission(user.role, "tickets.manage");

    const parsedStatus = SupportCaseStatusSchema.safeParse(
      req.nextUrl.searchParams.get("status"),
    );
    const limitParam = Number(req.nextUrl.searchParams.get("limit") ?? "50");
    const take = Number.isFinite(limitParam)
      ? Math.min(Math.max(1, limitParam), 100)
      : 50;

    const where = {
      ...(await visibleCaseWhere({ userId: user.id, role: user.role })),
      ...(parsedStatus.success ? { status: parsedStatus.data } : {}),
    };

    const cases = await prisma.supportCase.findMany({
      where,
      orderBy: [{ lastMessageAt: "desc" }, { createdAt: "desc" }],
      take,
      select: {
        id: true,
        referenceNumber: true,
        title: true,
        category: true,
        priority: true,
        status: true,
        caseKind: true,
        requesterUserId: true,
        submitterUserId: true,
        organizationId: true,
        appointmentId: true,
        appointmentOccurrenceId: true,
        callbackPhone: true,
        callbackWindow: true,
        ackDueAt: true,
        acknowledgedAt: true,
        resolutionDueAt: true,
        resolvedAt: true,
        lastMessageAt: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    const data = staff
      ? cases
      : cases.map((row) => {
          if (
            row.requesterUserId !== row.submitterUserId &&
            user.id !== row.submitterUserId
          ) {
            return {
              id: row.id,
              referenceNumber: row.referenceNumber,
              status: row.status,
              category: row.category,
              createdAt: row.createdAt,
              organizationId: row.organizationId,
              requesterUserId: row.requesterUserId,
              submitterUserId: null,
              title: "Organization support request",
              description: "",
              messages: [],
              events: [],
              subjects: [],
              callbackPhone: null,
              callbackWindow: null,
              filedByOrganizationNotice: true as const,
            };
          }
          return row;
        });

    return NextResponse.json({ data });
  } catch (cause) {
    return supportError({
      status: 500,
      code: "INTERNAL",
      cause,
      context: { route: "support.cases", action: "list" },
    });
  }
}

async function resolveCaseCreationBody(
  req: NextRequest,
  staff: boolean,
): Promise<
  | { ok: true; data: ParsedCaseCreationBody }
  | { ok: false; response: NextResponse }
> {
  const tooLarge = assertBodySize(req);
  if (tooLarge) return { ok: false, response: tooLarge };

  const rawBody: unknown = await req.json().catch(() => null);
  const parsed = staff
    ? StaffCreateCaseBodySchema.safeParse(rawBody)
    : ClientCreateCaseBodySchema.safeParse(rawBody);

  if (!parsed.success) {
    return {
      ok: false,
      response: supportError({
        status: 400,
        code: "VALIDATION_FAILED",
        detail: parsed.error.flatten(),
        context: { route: "support.cases", action: "create" },
      }),
    };
  }

  return { ok: true, data: parsed.data };
}

async function resolveOrgMembershipAccess(
  userId: string,
  requesterUserId: string,
  targetOrgId: string | null,
): Promise<
  | { ok: true; callerIsOrgOperator: boolean }
  | { ok: false; response: NextResponse }
> {
  if (requesterUserId !== userId) {
    if (!targetOrgId) {
      return {
        ok: false,
        response: supportError({
          status: 403,
          code: "FORBIDDEN",
          context: { route: "support.cases", action: "create" },
        }),
      };
    }
    const [submitterMembership, requesterMembership] = await Promise.all([
      prisma.membership.findFirst({
        where: {
          userId,
          organizationId: targetOrgId,
          status: "ACTIVE",
        },
        select: { role: true },
      }),
      prisma.membership.findFirst({
        where: {
          userId: requesterUserId,
          organizationId: targetOrgId,
          status: "ACTIVE",
        },
        select: { id: true },
      }),
    ]);
    if (
      !submitterMembership ||
      !ALLOWED_ORG_SUBMITTER_ROLES.has(submitterMembership.role) ||
      !requesterMembership
    ) {
      return {
        ok: false,
        response: supportError({
          status: 403,
          code: "FORBIDDEN",
          context: { route: "support.cases", action: "create" },
        }),
      };
    }
    return { ok: true, callerIsOrgOperator: true };
  }

  if (targetOrgId) {
    const submitterMembership = await prisma.membership.findFirst({
      where: {
        userId,
        organizationId: targetOrgId,
        status: "ACTIVE",
      },
      select: { id: true, role: true },
    });
    if (!submitterMembership) {
      return {
        ok: false,
        response: supportError({
          status: 403,
          code: "FORBIDDEN",
          context: { route: "support.cases", action: "create" },
        }),
      };
    }
    return {
      ok: true,
      callerIsOrgOperator: ALLOWED_ORG_SUBMITTER_ROLES.has(
        submitterMembership.role,
      ),
    };
  }

  return { ok: true, callerIsOrgOperator: false };
}

async function validateCaseScopeAccess(params: {
  staff: boolean;
  userId: string;
  requesterUserId: string;
  targetOrgId: string | null;
  appointmentId?: string | null;
  appointmentOccurrenceId?: string | null;
}): Promise<NextResponse | null> {
  let callerIsOrgOperator = false;
  if (!params.staff) {
    const orgCheck = await resolveOrgMembershipAccess(
      params.userId,
      params.requesterUserId,
      params.targetOrgId,
    );
    if (!orgCheck.ok) return orgCheck.response;
    callerIsOrgOperator = orgCheck.callerIsOrgOperator;
  }

  if (!params.appointmentId) return null;

  const appt = await prisma.appointment.findUnique({
    where: { id: params.appointmentId },
    select: {
      id: true,
      organizationId: true,
      participants: { select: { userId: true, organizationId: true } },
      payment: { select: { userId: true } },
      ...(params.appointmentOccurrenceId
        ? {
            occurrences: {
              where: { id: params.appointmentOccurrenceId },
              select: { id: true },
            },
          }
        : {}),
    },
  });

  if (!params.staff) {
    const requesterOnAppointment =
      appt !== null &&
      (appt.participants.some((p) => p.userId === params.requesterUserId) ||
        appt.payment.some((p) => p.userId === params.requesterUserId));
    const orgMatchesAppointment =
      appt !== null &&
      callerIsOrgOperator &&
      params.targetOrgId !== null &&
      (appt.organizationId === params.targetOrgId ||
        appt.participants.some((p) => p.organizationId === params.targetOrgId));

    if (!requesterOnAppointment && !orgMatchesAppointment) {
      return supportError({
        status: 403,
        code: "FORBIDDEN",
        context: { route: "support.cases", action: "create" },
      });
    }
  }

  if (params.appointmentOccurrenceId && !appt?.occurrences?.length) {
    return supportError({
      status: 400,
      code: "VALIDATION_FAILED",
      message: "appointmentOccurrenceId does not belong to appointmentId",
      context: { route: "support.cases", action: "create" },
    });
  }

  return null;
}

export async function POST(req: NextRequest) {
  try {
    const auth = await requireApiAuth();
    if (auth.error) return auth.error;
    const { user } = auth.session;
    const staff = hasBackofficePermission(user.role, "tickets.manage");

    const rl = await applyRateLimit(spamLimiter, `support-cases:${user.id}`);
    if (rl) return rl;

    const bodyRes = await resolveCaseCreationBody(req, staff);
    if (!bodyRes.ok) return bodyRes.response;

    const requesterUserId = bodyRes.data.requesterUserId ?? user.id;
    const targetOrgId = bodyRes.data.organizationId ?? null;

    const ownershipPermission = caseOwnershipPermission(
      bodyRes.data.ownershipScope ?? "PERSONAL",
    );
    if (ownershipPermission) {
      const member = targetOrgId
        ? await prisma.membership.findFirst({
            where: {
              organizationId: targetOrgId,
              userId: user.id,
              status: "ACTIVE",
            },
            select: { role: true },
          })
        : null;
      if (
        !staff &&
        (!member || !hasOrgPermission(member.role, ownershipPermission))
      )
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      if (!targetOrgId)
        return NextResponse.json(
          { error: "Organization is required" },
          { status: 400 },
        );
    }

    const accessErr = await validateCaseScopeAccess({
      staff,
      userId: user.id,
      requesterUserId,
      targetOrgId,
      appointmentId: bodyRes.data.appointmentId,
      appointmentOccurrenceId: bodyRes.data.appointmentOccurrenceId,
    });
    if (accessErr) return accessErr;

    const payment = bodyRes.data.paymentId
      ? await prisma.payment.findFirst({
          where: { id: bodyRes.data.paymentId, deletedAt: null },
          select: {
            id: true,
            userId: true,
            appointmentId: true,
            billingAccount: { select: { ownerOrgId: true } },
          },
        })
      : null;
    if (
      bodyRes.data.paymentId &&
      (!payment ||
        (!staff &&
          payment.userId !== user.id &&
          !(
            bodyRes.data.ownershipScope === "ORG_BILLING" &&
            payment.billingAccount?.ownerOrgId === targetOrgId
          )))
    )
      return NextResponse.json({ error: "Payment not found" }, { status: 404 });
    if (
      payment &&
      bodyRes.data.appointmentId &&
      payment.appointmentId !== bodyRes.data.appointmentId
    )
      return NextResponse.json(
        { error: "Payment does not belong to this booking" },
        { status: 400 },
      );
    const result = await createOrReuseSupportCase({
      ...bodyRes.data,
      subjects: payment
        ? [
            {
              subjectType: "PAYMENT",
              subjectId: payment.id,
              isPrimary: !bodyRes.data.appointmentId,
            },
          ]
        : bodyRes.data.subjects,
      requesterUserId,
      submitterUserId:
        staff && (bodyRes.data.ownershipScope ?? "PERSONAL") === "PERSONAL"
          ? requesterUserId
          : user.id,
      activeChannel: bodyRes.data.activeChannel ?? "HUMAN",
      initialSender: staff ? "AGENT" : "USER",
      initialAuthorUserId: user.id,
    });

    const viewerCase = await readSupportCaseForViewer(result.supportCase.id, {
      userId: user.id,
      isStaff: staff,
      role: user.role,
      canReadPayments: hasBackofficePermission(user.role, "payments.read"),
      canReadContact: hasBackofficePermission(user.role, "users.read"),
    });
    if (!viewerCase) {
      return supportError({
        status: 403,
        code: "FORBIDDEN",
        context: { route: "support.cases", action: "create" },
      });
    }

    return NextResponse.json(
      {
        data: viewerCase,
        reused: result.reused,
        dedupeReason: result.dedupeReason,
      },
      { status: result.reused ? 200 : 201 },
    );
  } catch (cause) {
    if (cause instanceof SupportCaseValidationError) {
      return supportError({
        status: 400,
        code: "VALIDATION_FAILED",
        message: cause.message,
        context: { route: "support.cases", action: "create" },
      });
    }
    return supportError({
      status: 500,
      code: "INTERNAL",
      cause,
      context: { route: "support.cases", action: "create" },
    });
  }
}
