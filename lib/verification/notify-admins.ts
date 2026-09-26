/**
 * Stage the "new consultant application" bells for every ADMIN/STAFF user
 * (outbox rows only) and hand back what `after()` should attempt. Shared by
 * the settings submit, the resubmit and the onboarding completion so the
 * three fire the same notice to the same roster.
 */

import prisma, { type Tx } from "@/lib/prisma";
import { UserRole } from "@prisma/client";
import {
  attemptTrigger,
  notifyNewConsultantApplication,
  type StagedTrigger,
} from "@/lib/novu";
import { getAppUrl } from "@/lib/url";
import { scheduleAfter } from "@/lib/api/after-safe";

export type AdminBellTx = Pick<
  Tx,
  "user" | "notificationOutbox" | "membership"
>;

/**
 * With `tx` (the submission transaction) the roster and applicant reads and
 * the outbox rows all ride the transaction and a failure PROPAGATES — the
 * request and its notice commit or roll back together. Without it (no
 * transaction to join) a failure is reported and yields an empty list.
 */
export async function stageNewApplicationBells(
  applicant: { userId: string },
  tx?: AdminBellTx,
): Promise<StagedTrigger[]> {
  const db = tx ?? prisma;
  const run = async () => {
    const [admins, user] = await Promise.all([
      db.user.findMany({
        where: { role: { in: [UserRole.ADMIN, UserRole.STAFF] } },
        select: { id: true, staffProfileId: true },
      }),
      db.user.findUnique({
        where: { id: applicant.userId },
        select: { name: true, email: true },
      }),
    ]);
    if (admins.length === 0) return [];
    // The verification queue lives on the users page, per tree:
    // `/dashboard/admin/*` bounces STAFF to their home, so each
    // recipient is pointed at the queue they can open (grouped by
    // queue — the shared admin queue plus one per distinct staff
    // profile — not one trigger per recipient).
    const byQueue = new Map<string, string[]>();
    for (const a of admins) {
      const queue = a.staffProfileId
        ? `/dashboard/staff/${a.staffProfileId}/users`
        : "/dashboard/admin/users";
      const bucket = byQueue.get(queue);
      if (bucket) bucket.push(a.id);
      else byQueue.set(queue, [a.id]);
    }
    const groups = await Promise.all(
      Array.from(byQueue, ([queue, ids]) =>
        notifyNewConsultantApplication(
          ids,
          {
            applicantName: user?.name ?? "Unknown",
            applicantEmail: user?.email ?? "",
            dashboardUrl: `${getAppUrl()}${queue}`,
          },
          { tx: db },
        ),
      ),
    );
    const byId = new Map<string, StagedTrigger>();
    for (const r of groups.flat()) {
      if (r.success && r.staged) byId.set(r.staged.id, r.staged);
    }
    return Array.from(byId.values());
  };
  if (tx) return run();
  try {
    return await run();
  } catch (error) {
    console.error("[verification] failed to stage admin bells:", error);
    return [];
  }
}

/** The `after()` half; never throws. */
export function attemptBellsAfterResponse(staged: StagedTrigger[]): void {
  if (staged.length === 0) return;
  scheduleAfter(async () => {
    for (const row of staged) await attemptTrigger(row);
  });
}
