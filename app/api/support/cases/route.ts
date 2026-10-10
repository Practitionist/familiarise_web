import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { isPrivileged, requireApiSession } from "@/lib/auth-helpers";
import { spamLimiter, applyRateLimit } from "@/lib/rate-limit";
import { assertBodySize } from "@/lib/validation/limits";
import { supportError } from "@/lib/api/support-http";
import { notifySupportTicketActivity } from "@/lib/novu";
import { notificationScope } from "@/lib/novu/workflows";
import { caseKeyOf } from "@/lib/support/case-key";
import {
  CreateSupportCaseObjectSchema,
  SupportCaseStatusSchema,
  createOrReuseSupportCase,
  readSupportCaseForViewer,
  refineCreateSupportCaseInput,
} from "@/lib/support/case-service";
import {
  notifyRequesterOfTicket,
  notifySupportStaff,
} from "@/lib/support/create-ticket";

const ALLOWED_ORG_SUBMITTER_ROLES = new Set<string>([
  "OWNER",
  "ADMIN",
  "MAINTAINER",
]);

const StaffCreateCaseBodySchema = CreateSupportCaseObjectSchema.omit({
  submitterUserId: true,
})
  .extend({
    requesterUserId: z.string().min(1).max(64).optional(),
  })
  .superRefine(refineCreateSupportCaseInput);

const ClientCreateCaseBodySchema = CreateSupportCaseObjectSchema.omit({
  submitterUserId: true,
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
  })
  .superRefine(refineCreateSupportCaseInput);

type ParsedCaseCreationBody = z.infer<typeof StaffCreateCaseBodySchema>;

export async function GET(req: NextRequest) {
  try {
    const auth = await requireApiSession();
    if (auth.error) return auth.error;
    const { user } = auth.session;
    const staff = isPrivileged(user.role);

    const parsedStatus = SupportCaseStatusSchema.safeParse(
      req.nextUrl.searchParams.get("status"),
    );
    const limitParam = Number(req.nextUrl.searchParams.get("limit") ?? "50");
    const take = Number.isFinite(limitParam)
      ? Math.min(Math.max(1, limitParam), 100)
      : 50;

    const where = staff
      ? {
          deletedAt: null,
          ...(parsedStatus.success ? { status: parsedStatus.data } : {}),
        }
      : {
          deletedAt: null,
          OR: [{ submitterUserId: user.id }, { requesterUserId: user.id }],
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

async function dispatchCasePostNotifications(
  result: Awaited<ReturnType<typeof createOrReuseSupportCase>>,
  actorName?: string | null,
): Promise<void> {
  const c = result.supportCase;
  if (!result.reused) {
    await Promise.all([
      notifySupportStaff(
        {
          id: c.id,
          title: c.title,
          organizationId: c.organizationId,
          referenceNumber: c.referenceNumber,
          userId: c.submitterUserId,
        },
        "case",
      ).catch(() => undefined),
      notifyRequesterOfTicket(
        {
          id: c.id,
          title: c.title,
          referenceNumber: c.referenceNumber,
          userId: c.submitterUserId,
          ackDueAt: c.ackDueAt,
          createdAt: c.createdAt,
          organizationId: c.organizationId,
        },
        "case",
      ).catch(() => undefined),
    ]);
    return;
  }

  if (result.dedupeReason === "open_scope") {
    const recipients = await prisma.user
      .findMany({
        where: c.assignedToId
          ? { id: c.assignedToId }
          : { role: { in: ["STAFF", "ADMIN"] } },
        select: { id: true, role: true },
      })
      .catch(() => []);
    if (recipients.length === 0) return;
    const caseKey = caseKeyOf({ kind: "case", id: c.id });
    const dedupeKey = `case-reply:${c.id}:seq:${c.messageSeq ?? 1}`;
    await Promise.all(
      recipients.map((r) =>
        notifySupportTicketActivity(
          [r.id],
          {
            ticketId: c.id,
            reference: c.referenceNumber,
            ticketTitle: c.title,
            userName: actorName ?? undefined,
            activity: "replied",
            dashboardUrl: `/dashboard/${r.role === "ADMIN" ? "admin" : "staff"}/support/${caseKey}`,
            ...notificationScope(c.organizationId),
          },
          dedupeKey,
        ).catch(() => undefined),
      ),
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const auth = await requireApiSession();
    if (auth.error) return auth.error;
    const { user } = auth.session;
    const staff = isPrivileged(user.role);

    const rl = await applyRateLimit(spamLimiter, `support-cases:${user.id}`);
    if (rl) return rl;

    const bodyRes = await resolveCaseCreationBody(req, staff);
    if (!bodyRes.ok) return bodyRes.response;

    const requesterUserId = bodyRes.data.requesterUserId ?? user.id;
    const targetOrgId = bodyRes.data.organizationId ?? null;

    const accessErr = await validateCaseScopeAccess({
      staff,
      userId: user.id,
      requesterUserId,
      targetOrgId,
      appointmentId: bodyRes.data.appointmentId,
      appointmentOccurrenceId: bodyRes.data.appointmentOccurrenceId,
    });
    if (accessErr) return accessErr;

    const result = await createOrReuseSupportCase({
      ...bodyRes.data,
      requesterUserId,
      submitterUserId: user.id,
    });

    await dispatchCasePostNotifications(result, user.name);

    const viewerCase = await readSupportCaseForViewer(result.supportCase.id, {
      userId: user.id,
      isStaff: staff,
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
    return supportError({
      status: 500,
      code: "INTERNAL",
      cause,
      context: { route: "support.cases", action: "create" },
    });
  }
}
