import { createHmac, timingSafeEqual, createHash } from "node:crypto";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { freezeAppointments } from "@/actions/maintenance/freeze-appointments";
import { withCronLock } from "@/lib/cron/with-cron-lock";
import { assertNotInMaintenance } from "@/lib/maintenance-cron";
import { liveParticipant } from "@/lib/booking/participants";
import { SLOT_RESCHEDULABLE_FROM } from "@/lib/booking/transitions";
import { assertMaintenanceRemediationCapacity } from "@/lib/maintenance-remediation-capacity";

export const remediationInput = z
  .object({
    windowId: z.string().min(1).max(200),
    startsAt: z.string().datetime({ offset: true }),
    endsAt: z.string().datetime({ offset: true }),
  })
  .refine(
    (v) =>
      new Date(v.endsAt) > new Date(v.startsAt) &&
      new Date(v.endsAt).getTime() - new Date(v.startsAt).getTime() <=
        86_400_000,
    { message: "Choose an explicit window up to 24 hours." },
  );

const previewSchema = z.object({
  windowId: z.string(),
  startsAt: z.string(),
  endsAt: z.string(),
  appointmentIds: z.array(z.string()).min(1).max(20),
  actorId: z.string(),
  expiresAt: z.number(),
});

export class RemediationInputError extends Error {}

function signature(value: string): string {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret)
    throw new Error("Maintenance confirmation signing is unavailable");
  return createHmac("sha256", secret).update(value).digest("hex");
}

export async function previewRemediation(
  input: z.infer<typeof remediationInput>,
  actorId: string,
) {
  const window = await prisma.maintenanceWindow.findFirst({
    where: { id: input.windowId, organizationId: null },
  });
  if (!window) throw new RemediationInputError("Maintenance window not found.");
  const overlap = {
    startsAt: { lt: new Date(input.endsAt) },
    endsAt: { gt: new Date(input.startsAt) },
    isTentative: false,
    deletedAt: null,
    completionStatus: { in: SLOT_RESCHEDULABLE_FROM },
  };
  const rows = await prisma.appointment.findMany({
    where: {
      deletedAt: null,
      occurrences: { some: overlap },
    },
    select: {
      id: true,
      appointmentType: true,
      occurrences: {
        where: overlap,
        orderBy: { startsAt: "asc" },
        take: 1,
        select: { startsAt: true, endsAt: true },
      },
      participants: {
        where: liveParticipant(),
        take: 5,
        select: { user: { select: { name: true } } },
      },
      _count: {
        select: {
          occurrences: { where: { deletedAt: null } },
          participants: { where: liveParticipant() },
        },
      },
    },
    orderBy: { id: "asc" },
    take: 21,
  });
  if (!rows.length || rows.length > 20)
    throw new RemediationInputError(
      "Choose a window affecting between 1 and 20 bookings.",
    );
  await assertMaintenanceRemediationCapacity(
    prisma,
    rows.map((row) => row.id),
  );
  const preview = {
    ...input,
    appointmentIds: rows.map((r) => r.id),
    actorId,
    expiresAt: Date.now() + 5 * 60_000,
  };
  const payload = Buffer.from(JSON.stringify(preview)).toString("base64url");
  return {
    ...preview,
    bookings: rows.map((row) => ({
      id: row.id,
      type: row.appointmentType,
      startsAt: row.occurrences[0].startsAt.toISOString(),
      endsAt: row.occurrences[0].endsAt.toISOString(),
      sessions: row._count.occurrences,
      participants: row.participants.map(
        (participant) => participant.user.name ?? "Unnamed user",
      ),
      participantCount: row._count.participants,
    })),
    token: `${payload}.${signature(payload)}`,
    confirmation: `CANCEL ${rows.length} BOOKINGS`,
  };
}

export function confirmRemediation(
  token: string,
  confirmation: string,
  actorId: string,
) {
  const [payload, mac, extra] = token.split(".");
  if (
    !payload ||
    !mac ||
    extra ||
    !/^[a-f0-9]{64}$/.test(mac) ||
    !timingSafeEqual(
      Buffer.from(signature(payload), "hex"),
      Buffer.from(mac, "hex"),
    )
  )
    throw new RemediationInputError("Invalid confirmation token");
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(payload, "base64url").toString());
  } catch {
    throw new RemediationInputError("Invalid confirmation token");
  }
  const parsed = previewSchema.safeParse(raw);
  if (!parsed.success)
    throw new RemediationInputError("Invalid confirmation token");
  const preview = parsed.data;
  if (
    preview.expiresAt < Date.now() ||
    preview.actorId !== actorId ||
    confirmation !== `CANCEL ${preview.appointmentIds.length} BOOKINGS`
  )
    throw new RemediationInputError(
      "Preview expired or confirmation does not match",
    );
  const id = createHash("sha256")
    .update(
      JSON.stringify([
        preview.windowId,
        preview.startsAt,
        preview.endsAt,
        preview.appointmentIds,
      ]),
    )
    .digest("hex");
  return { ...preview, id };
}

/** One booking per slice; refund and notification obligations commit with cancellation. */
export async function runMaintenanceRemediationSlice() {
  return withCronLock(
    "maintenance-booking-remediation",
    { failMode: "closed" },
    async () => {
      await assertNotInMaintenance("maintenance-booking-remediation");
      const item = await prisma.maintenanceRemediationItem.findFirst({
        where: { completedAt: null },
        orderBy: [{ attempts: "asc" }, { id: "asc" }],
        include: { remediation: true },
      });
      if (!item) return { success: true, processed: 0 };
      await prisma.maintenanceRemediationItem.updateMany({
        where: { id: item.id, completedAt: null },
        data: { attempts: { increment: 1 } },
      });
      try {
        const result = await freezeAppointments(
          item.remediation.startsAt,
          item.remediation.endsAt,
          item.appointmentId,
        );
        if (result.freezeErrors)
          throw new Error(`${result.freezeErrors} booking cancellation errors`);
        await prisma.$transaction(async (tx) => {
          await tx.maintenanceRemediationItem.updateMany({
            where: { id: item.id, completedAt: null },
            data: { completedAt: new Date(), lastError: null },
          });
          const pending = await tx.maintenanceRemediationItem.count({
            where: { remediationId: item.remediationId, completedAt: null },
          });
          if (!pending)
            await tx.maintenanceRemediation.updateMany({
              where: { id: item.remediationId, completedAt: null },
              data: { completedAt: new Date() },
            });
        });
        return { success: true, processed: 1, result };
      } catch (error) {
        await prisma.maintenanceRemediationItem.updateMany({
          where: { id: item.id, completedAt: null },
          data: {
            lastError: (error instanceof Error
              ? error.message
              : String(error)
            ).slice(0, 1000),
          },
        });
        throw error;
      }
    },
  );
}
