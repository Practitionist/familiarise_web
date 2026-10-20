import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { evidenceRecipients } from "@/lib/support/case-actions";
import { requireApiAuth, requireOrgAccess } from "@/lib/auth-helpers";
import { evidenceAppointmentScope } from "@/lib/support/evidence-scope";
const Query = z.object({
  organizationId: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9_-]+$/)
    .optional(),
});
export async function GET(req: NextRequest) {
  const auth = await requireApiAuth();
  if (auth.error) return auth.error;
  const query = Query.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!query.success)
    return NextResponse.json(
      { error: "Invalid evidence scope" },
      { status: 400 },
    );
  const organizationId = query.data.organizationId;
  if (organizationId) {
    const access = await requireOrgAccess(organizationId, { readOnly: true });
    if (access.error) return access.error;
  }
  const data = await prisma.supportCaseEvidenceRequest.findMany({
    where: {
      recipientUserId: auth.session.user.id,
      supportCase: {
        deletedAt: null,
        ...(organizationId
          ? { appointment: evidenceAppointmentScope(organizationId) }
          : {}),
      },
    },
    orderBy: [{ respondedAt: "asc" }, { dueAt: "asc" }],
    take: 100,
    select: {
      id: true,
      prompt: true,
      dueAt: true,
      respondedAt: true,
      cancelledAt: true,
      supportCase: {
        select: { appointmentId: true, resolvedAt: true, closedAt: true },
      },
    },
  });
  const allowedAppointments = new Set<string>();
  for (const appointmentId of new Set(
    data.flatMap((row) =>
      row.supportCase.appointmentId ? [row.supportCase.appointmentId] : [],
    ),
  )) {
    const recipients = await prisma.$transaction((tx) =>
      evidenceRecipients(tx, appointmentId),
    );
    if (recipients.some((recipient) => recipient.id === auth.session.user.id))
      allowedAppointments.add(appointmentId);
  }
  return NextResponse.json({
    data: data
      .filter(
        (row) =>
          row.supportCase.appointmentId &&
          allowedAppointments.has(row.supportCase.appointmentId),
      )
      .map(({ supportCase, ...row }) => ({
        ...row,
        caseClosed: Boolean(supportCase.resolvedAt || supportCase.closedAt),
      })),
  });
}
