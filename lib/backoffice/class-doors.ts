import prisma from "@/lib/prisma";
import { readHostedClass } from "@/lib/booking/class-sessions";
import { OpsRefusal } from "./ops-refusal-error";

/**
 * #1771 K-6 — the class behind a console door, acted on as a privileged actor.
 * The host-only check lives in the HTTP shell (class-session-route.ts), so the
 * console calls the lib functions directly, with the operator as the actor.
 */
export async function hostedForClass(classId: string, operatorUserId: string) {
  const cls = await prisma.class.findUnique({
    where: { id: classId },
    select: { appointment: { select: { id: true } } },
  });
  const appointmentId = cls?.appointment?.id;
  const hosted = appointmentId
    ? await readHostedClass(appointmentId, {
        userId: operatorUserId,
        consultantProfileId: null,
        isPrivileged: true,
      })
    : null;
  if (!hosted?.found) {
    throw new OpsRefusal("CLASS_NOT_FOUND", "Class not found.", 404);
  }
  return hosted;
}
