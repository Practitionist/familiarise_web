import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { attachmentCaseAccess } from "@/lib/support/case-attachments";
import { requireApiAuth } from "@/lib/auth-helpers";
import { hasBackofficePermission } from "@/lib/auth/backoffice-permissions";
import { assertBodySize } from "@/lib/validation/limits";
import { evidenceRecipients } from "@/lib/support/case-actions";
import { stageCaseNotice } from "@/lib/support/case-notice";
import { spamLimiter, applyRateLimit } from "@/lib/rate-limit";
import { sessionRole } from "@/lib/auth/session-role";
import { PLAN_TITLE_SELECT, planTitle } from "@/lib/support/case-read";
import { parseRouteParams } from "@/lib/api/support-http";
import { EvidenceRequestIdParams } from "@/schemas/support";

const ROUTE = "support.evidence.detail";

interface Context {
  params: Promise<{ requestId: string }>;
}
const ResponseSchema = z.object({
  body: z.string().trim().min(1).max(10_000),
  clientTurnId: z.string().min(1).max(128),
});
export async function GET(_req: NextRequest, context: Context) {
  const id = await parseRouteParams(EvidenceRequestIdParams, context.params, {
    route: ROUTE,
  });
  if (!id.ok) return id.response;
  const auth = await requireApiAuth();
  if (auth.error) return auth.error;
  const { requestId } = id.data;
  const row = await prisma.supportCaseEvidenceRequest.findFirst({
    where: {
      id: requestId,
      ...(!hasBackofficePermission(
        sessionRole(auth.session.user.role),
        "tickets.manage",
      )
        ? { recipientUserId: auth.session.user.id }
        : {}),
    },
    select: {
      id: true,
      caseId: true,
      prompt: true,
      dueAt: true,
      responseBody: true,
      respondedAt: true,
      cancelledAt: true,
      createdAt: true,
    },
  });
  const authorized =
    row &&
    (await attachmentCaseAccess(
      row.caseId,
      {
        userId: auth.session.user.id,
        role: sessionRole(auth.session.user.role),
      },
      requestId,
    ));
  if (!authorized || !row)
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  const decisions = await prisma.supportCaseDecision.findMany({
    where: { caseId: row.caseId },
    orderBy: { createdAt: "asc" },
    select: { id: true, outcome: true, appealUntil: true, createdAt: true },
  });
  const booking = authorized.supportCase.appointmentId
    ? await prisma.appointment.findUnique({
        where: { id: authorized.supportCase.appointmentId },
        select: {
          ...PLAN_TITLE_SELECT,
          organization: { select: { name: true } },
          occurrences: {
            orderBy: { startsAt: "asc" },
            take: 1,
            select: { startsAt: true },
          },
        },
      })
    : null;
  return NextResponse.json({
    data: {
      ...row,
      caseClosed: Boolean(
        authorized.supportCase.resolvedAt || authorized.supportCase.closedAt,
      ),
      decisions,
      booking: booking
        ? {
            title: planTitle(booking),
            startsAt: booking.occurrences[0]?.startsAt ?? null,
            organizationName: booking.organization?.name ?? null,
          }
        : null,
    },
  });
}
export async function POST(req: NextRequest, context: Context) {
  const id = await parseRouteParams(EvidenceRequestIdParams, context.params, {
    route: ROUTE,
  });
  if (!id.ok) return id.response;
  const auth = await requireApiAuth({ expectUser: true });
  if (auth.error) return auth.error;
  const limited = await applyRateLimit(
    spamLimiter,
    `evidence-response:${auth.session.user.id}`,
  );
  if (limited) return limited;
  const tooLarge = assertBodySize(req);
  if (tooLarge) return tooLarge;
  const input = ResponseSchema.safeParse(await req.json().catch(() => null));
  if (!input.success)
    return NextResponse.json({ error: "Write a response" }, { status: 400 });
  const { requestId } = id.data;
  const outcome = await prisma.$transaction(async (tx) => {
    const row = await tx.supportCaseEvidenceRequest.findFirst({
      where: { id: requestId, recipientUserId: auth.session.user.id },
      include: { supportCase: true },
    });
    if (!row) return { status: 404, error: "Not found" };
    if (row.responseClientId === input.data.clientTurnId && row.respondedAt)
      return {
        status: 200,
        data: {
          respondedAt: row.respondedAt,
          late: row.respondedAt > row.dueAt,
        },
      };
    if (
      row.cancelledAt ||
      row.respondedAt ||
      row.supportCase.resolvedAt ||
      row.supportCase.deletedAt
    )
      return {
        status: 409,
        error:
          "This evidence request has closed or already received a response",
      };
    const eligible = await evidenceRecipients(
      tx,
      row.supportCase.appointmentId,
    );
    if (!eligible.some((person) => person.id === auth.session.user.id))
      return {
        status: 403,
        error: "Your delivery or organization access has changed",
      };
    const now = new Date();
    const parent = await tx.supportCase.updateMany({
      where: {
        id: row.caseId,
        updatedAt: row.supportCase.updatedAt,
        resolvedAt: null,
        deletedAt: null,
      },
      data: { updatedAt: now },
    });
    if (!parent.count)
      return {
        status: 409,
        error: "The case changed. Reload before submitting evidence.",
      };
    const moved = await tx.supportCaseEvidenceRequest.updateMany({
      where: {
        id: requestId,
        recipientUserId: auth.session.user.id,
        respondedAt: null,
        cancelledAt: null,
      },
      data: {
        responseBody: input.data.body,
        responseClientId: input.data.clientTurnId,
        respondedAt: now,
      },
    });
    if (!moved.count)
      return {
        status: 409,
        error: "This evidence request changed. Reload before retrying.",
      };
    await tx.supportCaseEvent.create({
      data: {
        caseId: row.caseId,
        actorId: auth.session.user.id,
        kind: "VISIBILITY_CHANGED",
        note: `Evidence received: ${row.id}${now > row.dueAt ? " (late)" : ""}`,
      },
    });
    await stageCaseNotice(
      tx,
      row.supportCase,
      row.supportCase.assignedToId
        ? [row.supportCase.assignedToId]
        : [row.requestedById],
      "Evidence received",
      `evidence-response:${row.id}`,
    );
    return { status: 200, data: { respondedAt: now, late: now > row.dueAt } };
  });
  return NextResponse.json(
    "data" in outcome ? { data: outcome.data } : { error: outcome.error },
    { status: outcome.status },
  );
}
