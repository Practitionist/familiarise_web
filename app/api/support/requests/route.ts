import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { requireApiAuth } from "@/lib/auth-helpers";
import { supportError } from "@/lib/api/support-http";
import {
  ORG_FILED_CASE_TITLE,
  projectCaseForViewer,
  visibleCaseAccess,
} from "@/lib/support/case-access";
import { PLAN_TITLE_SELECT, planTitle } from "@/lib/support/case-read";
import { SupportCaseStatus, type Prisma } from "@prisma/client";

const Query = z.object({
  scope: z.enum(["session", "platform"]).optional(),
  ownership: z.literal("personal").optional(),
  status: z.nativeEnum(SupportCaseStatus).optional(),
  page: z.coerce.number().int().min(1).max(10000).default(1),
});
export async function GET(req: NextRequest) {
  const auth = await requireApiAuth();
  if (auth.error) return auth.error;
  const query = Query.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!query.success)
    return supportError({ status: 400, code: "VALIDATION_FAILED" });
  const access = await visibleCaseAccess({
    userId: auth.session.user.id,
    role: "CONSULTEE",
  });
  const visible = access.where;
  const scopeFilters: Prisma.SupportCaseWhereInput[] = [];
  if (query.data.scope === "session")
    scopeFilters.push({ appointmentId: { not: null } });
  if (query.data.scope === "platform")
    scopeFilters.push({ appointmentId: null });
  const where: Prisma.SupportCaseWhereInput = {
    AND: [
      visible,
      ...(query.data.ownership
        ? [
            {
              OR: [
                { ownershipScope: "PERSONAL" as const },
                {
                  requesterUserId: auth.session.user.id,
                  NOT: { submitterUserId: auth.session.user.id },
                },
              ],
            },
          ]
        : []),
      ...(query.data.status ? [{ status: query.data.status }] : []),
      ...scopeFilters,
    ],
  };
  const pageSize = 20;
  const [cases, total] = await Promise.all([
    prisma.supportCase.findMany({
      where,
      take: pageSize,
      skip: (query.data.page - 1) * pageSize,
      orderBy: [
        { lastMessageAt: { sort: "desc", nulls: "last" } },
        { createdAt: "desc" },
      ],
      select: {
        id: true,
        title: true,
        referenceNumber: true,
        category: true,
        status: true,
        activeChannel: true,
        appointmentId: true,
        ownershipScope: true,
        organizationId: true,
        requesterUserId: true,
        submitterUserId: true,
        createdAt: true,
        updatedAt: true,
        lastMessageAt: true,
        resolvedAt: true,
        organization: { select: { id: true, name: true } },
        appointment: {
          select: {
            ...PLAN_TITLE_SELECT,
            organization: { select: { name: true } },
            occurrences: {
              orderBy: { startsAt: "asc" },
              take: 1,
              select: { startsAt: true },
            },
          },
        },
        messages: {
          where: { isInternal: false },
          orderBy: { seq: "desc" },
          take: 1,
          select: { sender: true, body: true, createdAt: true },
        },
      },
    }),
    prisma.supportCase.count({ where }),
  ]);
  return NextResponse.json(
    {
      pagination: { page: query.data.page, pageSize, total },
      data: cases.map((c) => {
        const redacted = projectCaseForViewer(
          c,
          auth.session.user.id,
          access.canCorrespond(c),
        ).summaryOnly;
        const lastMessage = redacted ? undefined : c.messages[0];
        return {
          id: c.id,
          title: redacted ? ORG_FILED_CASE_TITLE : c.title,
          referenceNumber: c.referenceNumber,
          category: c.category,
          status: c.status,
          activeChannel: c.activeChannel,
          appointmentId: c.appointmentId,
          createdAt: c.createdAt,
          updatedAt: c.updatedAt,
          lastMessageAt: c.lastMessageAt ?? c.createdAt,
          resolvedAt: c.resolvedAt,
          organization: c.organization,
          responses: redacted
            ? []
            : c.messages.map((m) => ({
                message: m.body,
                createdAt: m.createdAt,
                isInternal: false,
              })),
          lastMessage: lastMessage
            ? { sender: lastMessage.sender, body: lastMessage.body }
            : null,
          appointment: c.appointment
            ? {
                appointmentType: c.appointment.appointmentType,
                planTitle: planTitle(c.appointment),
                startsAt: c.appointment.occurrences[0]?.startsAt ?? null,
                organizationName: c.appointment.organization?.name ?? null,
              }
            : null,
        };
      }),
    },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
