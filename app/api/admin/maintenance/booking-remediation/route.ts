import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireBackofficeSurface } from "@/lib/auth-helpers";
import { requireFreshSession } from "@/lib/auth/step-up";
import { opsActorOf, recordOpsAction } from "@/lib/backoffice/ops-action-log";
import { opsReasonSchema } from "@/lib/backoffice/ops-reason";
import prisma from "@/lib/prisma";
import {
  confirmRemediation,
  previewRemediation,
  remediationInput,
  RemediationInputError,
} from "@/lib/maintenance-remediation";
import { captureThrottled } from "@/lib/observability/throttled-capture";
import {
  assertMaintenanceRemediationCapacity,
  MaintenanceRemediationCapacityError,
} from "@/lib/maintenance-remediation-capacity";

const confirmSchema = z.object({
  token: z.string().max(20_000),
  confirmation: z.string(),
  reason: opsReasonSchema,
});

export async function GET(request: NextRequest) {
  const auth = await requireBackofficeSurface("maintenance.manage");
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
  const auth = await requireBackofficeSurface("maintenance.manage");
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
      await assertMaintenanceRemediationCapacity(tx, confirmed.appointmentIds);
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
      const actor = opsActorOf(auth.session);
      await recordOpsAction(tx, {
        actorUserId: actor.userId,
        actorRole: actor.role,
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
    const invalid =
      error instanceof RemediationInputError ||
      error instanceof MaintenanceRemediationCapacityError;
    if (!invalid)
      captureThrottled("maintenance:booking-remediation", error, {
        subsystem: "maintenance",
      });
    return NextResponse.json(
      {
        error: invalid
          ? error.message
          : "Booking remediation is unavailable. Retry after restoring prerequisites.",
      },
      { status: invalid ? 400 : 503 },
    );
  }
}
