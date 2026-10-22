import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdminAuth } from "@/lib/auth-helpers";
import { requireFreshSession } from "@/lib/auth/step-up";
import {
  recordOpsAction,
  opsReasonSchema,
} from "@/lib/backoffice/ops-action-log";
import prisma from "@/lib/prisma";
import {
  confirmRemediation,
  previewRemediation,
  remediationInput,
  RemediationInputError,
} from "@/lib/maintenance-remediation";
import { captureThrottled } from "@/lib/observability/throttled-capture";

const confirmSchema = z.object({
  token: z.string().max(20_000),
  confirmation: z.string(),
  reason: opsReasonSchema,
});

export async function GET(request: NextRequest) {
  const auth = await requireAdminAuth();
  if (auth.error) return auth.error;
  const windowId = z
    .string()
    .min(1)
    .max(200)
    .safeParse(request.nextUrl.searchParams.get("windowId"));
  if (!windowId.success)
    return NextResponse.json(
      { error: "Provide a maintenance window ID" },
      { status: 400 },
    );
  const requests = await prisma.maintenanceRemediation.findMany({
    where: { windowId: windowId.data },
    orderBy: { createdAt: "desc" },
    take: 10,
    select: {
      id: true,
      reason: true,
      createdAt: true,
      completedAt: true,
      items: {
        select: {
          appointmentId: true,
          completedAt: true,
          attempts: true,
          lastError: true,
        },
        orderBy: { id: "asc" },
        take: 20,
      },
    },
  });
  return NextResponse.json({ requests });
}

export async function POST(request: NextRequest) {
  const auth = await requireAdminAuth();
  if (auth.error) return auth.error;
  const stale = requireFreshSession(auth.session);
  if (stale) return stale;
  const raw: unknown = await request.json().catch(() => null);
  const preview = remediationInput.safeParse(raw);
  try {
    if (preview.success)
      return NextResponse.json(
        await previewRemediation(preview.data, auth.session.user.id),
      );
    const body = confirmSchema.safeParse(raw);
    if (!body.success)
      return NextResponse.json(
        {
          error:
            "Provide a preview window or its signed confirmation and reason.",
        },
        { status: 400 },
      );
    const confirmed = confirmRemediation(
      body.data.token,
      body.data.confirmation,
      auth.session.user.id,
    );
    await prisma.$transaction(async (tx) => {
      const window = await tx.maintenanceWindow.findFirst({
        where: { id: confirmed.windowId, organizationId: null },
      });
      if (!window)
        throw new RemediationInputError("Maintenance window not found.");
      const { count } = await tx.maintenanceRemediation.createMany({
        data: [
          {
            id: confirmed.id,
            windowId: confirmed.windowId,
            startsAt: new Date(confirmed.startsAt),
            endsAt: new Date(confirmed.endsAt),
            appointmentIds: confirmed.appointmentIds,
            requestedBy: auth.session.user.id,
            reason: body.data.reason,
          },
        ],
        skipDuplicates: true,
      });
      if (!count) return;
      await tx.maintenanceRemediationItem.createMany({
        data: confirmed.appointmentIds.map((appointmentId) => ({
          remediationId: confirmed.id,
          appointmentId,
        })),
      });
      await recordOpsAction(tx, {
        actorUserId: auth.session.user.id,
        actorRole: "ADMIN",
        surface: "maintenance.manage",
        action: "maintenance.booking-remediation.confirm",
        targetKind: "MaintenanceRemediation",
        targetId: confirmed.id,
        reason: body.data.reason,
        after: {
          appointmentIds: confirmed.appointmentIds,
          startsAt: confirmed.startsAt,
          endsAt: confirmed.endsAt,
        },
      });
    });
    return NextResponse.json(
      {
        remediationId: confirmed.id,
        queued: confirmed.appointmentIds.length,
        message:
          "Confirmed cancellations queued. They run in bounded slices after maintenance ends.",
      },
      { status: 202 },
    );
  } catch (error) {
    if (!(error instanceof RemediationInputError))
      captureThrottled("maintenance:booking-remediation", error, {
        subsystem: "maintenance",
      });
    return NextResponse.json(
      {
        error:
          error instanceof RemediationInputError
            ? error.message
            : "Booking remediation is unavailable. Retry after restoring prerequisites.",
      },
      { status: error instanceof RemediationInputError ? 400 : 503 },
    );
  }
}
