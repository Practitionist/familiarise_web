import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { evidenceRecipients } from "@/lib/support/case-actions";
import { requireApiAuth } from "@/lib/auth-helpers";
export async function GET() {
  const auth = await requireApiAuth();
  if (auth.error) return auth.error;
  const data = await prisma.supportCaseEvidenceRequest.findMany({
    where: { recipientUserId: auth.session.user.id },
    orderBy: [{ respondedAt: "asc" }, { dueAt: "asc" }],
    take: 100,
    select: {
      id: true,
      prompt: true,
      dueAt: true,
      respondedAt: true,
      cancelledAt: true,
      supportCase: { select: { appointmentId: true } },
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
      .map(({ supportCase: _case, ...row }) => row),
  });
}
