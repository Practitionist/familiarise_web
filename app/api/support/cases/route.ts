import {
  visibleCaseAccess,
  caseOwnershipPermission,
  projectCaseForViewer,
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
  type CreateSupportCaseInput,
  SupportCaseStatusSchema,
  SupportCaseValidationError,
  createOrReuseSupportCase,
  readSupportCaseForViewer,
  refineCreateSupportCaseInput,
} from "@/lib/support/case-service";
import { sessionRole } from "@/lib/auth/session-role";
import {
  SupportIssueTypeEnum,
  SupportThreadCategoryEnum,
} from "@/schemas/enums";

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
    category: z
      .union([SupportIssueTypeEnum, SupportThreadCategoryEnum])
      .nullable()
      .optional(),
    requesterUserId: z.string().min(1).max(64).optional(),
    paymentId: z.string().min(1).max(64).optional(),
  })
  .superRefine(refineCreateSupportCaseInput);

const ListQuerySchema = z.object({
  status: SupportCaseStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

type ParsedCaseCreationBody = z.infer<typeof StaffCreateCaseBodySchema>;

export async function GET(req: NextRequest) {
  try {
    const auth = await requireApiAuth();
    if (auth.error) return auth.error;
    const { user } = auth.session;
    const staff = hasBackofficePermission(
      sessionRole(user.role),
      "tickets.manage",
    );

    const query = ListQuerySchema.safeParse({
      status: req.nextUrl.searchParams.get("status") ?? undefined,
      limit: req.nextUrl.searchParams.get("limit") ?? undefined,
    });
    if (!query.success)
      return supportError({
        status: 400,
        code: "VALIDATION_FAILED",
        detail: query.error.flatten(),
        context: { route: "support.cases", action: "list" },
      });
    const { status, limit: take } = query.data;

    const access = await visibleCaseAccess({
      userId: user.id,
      role: sessionRole(user.role),
    });
    const where = { ...access.where, ...(status ? { status } : {}) };

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
        ownershipScope: true,
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
          const view = projectCaseForViewer(
            row,
            user.id,
            access.canCorrespond(row),
          );
          if (view.summaryOnly) return view.summary;
          return {
            ...row,
            callbackPhone:
              row.submitterUserId === user.id ? row.callbackPhone : null,
          };
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
  | { ok: true; callerIsOrgOperator: boolean; onBehalf: boolean }
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
    return { ok: true, callerIsOrgOperator: true, onBehalf: true };
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
      onBehalf: false,
    };
  }

  return { ok: true, callerIsOrgOperator: false, onBehalf: false };
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
  let onBehalf = false;
  if (!params.staff) {
    const orgCheck = await resolveOrgMembershipAccess(
      params.userId,
      params.requesterUserId,
      params.targetOrgId,
    );
    if (!orgCheck.ok) return orgCheck.response;
    callerIsOrgOperator = orgCheck.callerIsOrgOperator;
    onBehalf = orgCheck.onBehalf;
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

    // Filing for another member reaches only the organization's own bookings.
    if (
      onBehalf
        ? !orgMatchesAppointment
        : !requesterOnAppointment && !orgMatchesAppointment
    ) {
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

async function validateCaseOwnershipAccess(
  data: ParsedCaseCreationBody,
  staff: boolean,
  userId: string,
): Promise<NextResponse | null> {
  const targetOrgId = data.organizationId ?? null;
  const ownershipPermission = caseOwnershipPermission(
    data.ownershipScope ?? "PERSONAL",
  );
  if (ownershipPermission) {
    const member = targetOrgId
      ? await prisma.membership.findFirst({
          where: {
            organizationId: targetOrgId,
            userId,
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

  return null;
}

async function resolveCasePayment(
  data: ParsedCaseCreationBody,
  staff: boolean,
  userId: string,
  targetOrgId: string | null,
) {
  const payment = data.paymentId
    ? await prisma.payment.findFirst({
        where: { id: data.paymentId, deletedAt: null },
        select: {
          id: true,
          userId: true,
          appointmentId: true,
          billingAccount: { select: { ownerOrgId: true } },
        },
      })
    : null;
  if (
    data.paymentId &&
    (!payment ||
      (!staff &&
        payment.userId !== userId &&
        !(
          data.ownershipScope === "ORG_BILLING" &&
          payment.billingAccount?.ownerOrgId === targetOrgId
        )))
  )
    return {
      ok: false as const,
      response: NextResponse.json(
        { error: "Payment not found" },
        { status: 404 },
      ),
    };
  if (
    payment &&
    data.appointmentId &&
    payment.appointmentId !== data.appointmentId
  )
    return {
      ok: false as const,
      response: NextResponse.json(
        { error: "Payment does not belong to this booking" },
        { status: 400 },
      ),
    };
  return { ok: true as const, payment };
}

/**
 * A case a member files for another member belongs to the organization, so
 * access follows current membership rather than the filing operator.
 */
function withOnBehalfOwnership(
  data: ParsedCaseCreationBody,
  staff: boolean,
  userId: string,
): ParsedCaseCreationBody {
  const onBehalf = !staff && (data.requesterUserId ?? userId) !== userId;
  return onBehalf && (data.ownershipScope ?? "PERSONAL") === "PERSONAL"
    ? { ...data, ownershipScope: "ORG_OPERATIONS" }
    : data;
}

/** Staff file personal cases as the customer; everyone else files as themselves. */
function caseCreateInput(
  data: ParsedCaseCreationBody,
  ctx: {
    paymentId: string | null;
    staff: boolean;
    userId: string;
    requesterUserId: string;
  },
): CreateSupportCaseInput {
  const personal = (data.ownershipScope ?? "PERSONAL") === "PERSONAL";
  return {
    ...data,
    subjects: ctx.paymentId
      ? [
          {
            subjectType: "PAYMENT",
            subjectId: ctx.paymentId,
            isPrimary: !data.appointmentId,
          },
        ]
      : data.subjects,
    requesterUserId: ctx.requesterUserId,
    submitterUserId: ctx.staff && personal ? ctx.requesterUserId : ctx.userId,
    activeChannel: data.activeChannel ?? "HUMAN",
    initialSender: ctx.staff ? "AGENT" : "USER",
    initialAuthorUserId: ctx.userId,
  };
}

export async function POST(req: NextRequest) {
  try {
    const auth = await requireApiAuth();
    if (auth.error) return auth.error;
    const { user } = auth.session;
    const staff = hasBackofficePermission(
      sessionRole(user.role),
      "tickets.manage",
    );

    // Operators who manage tickets file on customers' behalf all day.
    const rl = staff
      ? null
      : await applyRateLimit(spamLimiter, `support-cases:${user.id}`);
    if (rl) return rl;

    const bodyRes = await resolveCaseCreationBody(req, staff);
    if (!bodyRes.ok) return bodyRes.response;

    const requesterUserId = bodyRes.data.requesterUserId ?? user.id;
    const targetOrgId = bodyRes.data.organizationId ?? null;
    const data = withOnBehalfOwnership(bodyRes.data, staff, user.id);

    const ownershipError = await validateCaseOwnershipAccess(
      data,
      staff,
      user.id,
    );
    if (ownershipError) return ownershipError;

    const accessErr = await validateCaseScopeAccess({
      staff,
      userId: user.id,
      requesterUserId,
      targetOrgId,
      appointmentId: data.appointmentId,
      appointmentOccurrenceId: data.appointmentOccurrenceId,
    });
    if (accessErr) return accessErr;

    const paymentResult = await resolveCasePayment(
      data,
      staff,
      user.id,
      targetOrgId,
    );
    if (!paymentResult.ok) return paymentResult.response;
    const { payment } = paymentResult;
    const result = await createOrReuseSupportCase(
      caseCreateInput(data, {
        paymentId: payment?.id ?? null,
        staff,
        userId: user.id,
        requesterUserId,
      }),
    );

    const viewerCase = await readSupportCaseForViewer(result.supportCase.id, {
      userId: user.id,
      isStaff: staff,
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
