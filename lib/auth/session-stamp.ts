import prisma from "@/lib/prisma";
import { captureThrottled } from "@/lib/observability/throttled-capture";
import { deriveDeviceLabel } from "@/lib/auth/device-label";

/**
 * Stamp `deviceLabel` + `lastSeenAt` onto a freshly created session
 * (#1856).
 *
 * Runs in `databaseHooks.session.create.after`, DELIBERATELY not in
 * `create.before`: merging the columns into the insert made the stamp
 * load-bearing for auth. An update that fails is throttled-reported
 * and swallowed instead, so a STAMP failure never fails sign-in.
 *
 * Honest limit, proven by local repro (#1857): the INSERT itself still
 * needs the columns until the push, because the regenerated Prisma
 * client selects all model fields by default (RETURNING *) even when
 * the insert data is clean. No hook placement avoids that — only the
 * merge-time `db:push` does. Pre-push the rows stay null (the
 * read-time derivation in `toPublicSession` and the `updatedAt`
 * fallback cover the gap); post-push they fill in.
 *
 * Awaited by the hook (one PK update on a rare path) so a serverless
 * freeze after the response cannot drop it — the #1298/#1616 class.
 * Failures report throttled: pre-push EVERY sign-in fails this update,
 * and an unthrottled capture would page per sign-in.
 */
export async function stampSessionDeviceMetadata(
  sessionId: string,
  userAgent: string | null | undefined,
): Promise<void> {
  try {
    await prisma.session.update({
      where: { id: sessionId },
      data: {
        deviceLabel: deriveDeviceLabel(userAgent),
        lastSeenAt: new Date(),
      },
    });
  } catch (error) {
    captureThrottled("session:stampDevice", error, {
      subsystem: "auth",
      op: "stampSessionDeviceMetadata",
      expected: true,
      level: "warning",
    });
  }
}
