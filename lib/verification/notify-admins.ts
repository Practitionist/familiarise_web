/**
 * Stage the "new consultant application" bells for every ADMIN/STAFF user
 * (outbox rows only) and hand back what `after()` should attempt. Shared by
 * the settings submit, the resubmit and the onboarding completion so the
 * three fire the same notice to the same roster.
 */

import prisma from "@/lib/prisma";
import { UserRole } from "@prisma/client";
import {
  attemptTrigger,
  notifyNewConsultantApplication,
  type StagedTrigger,
} from "@/lib/novu";
import { scheduleAfter } from "@/lib/api/after-safe";

export async function stageNewApplicationBells(applicant: {
  name: string | null;
  email: string | null;
  dashboardUrl: string;
}): Promise<StagedTrigger[]> {
  try {
    const admins = await prisma.user.findMany({
      where: { role: { in: [UserRole.ADMIN, UserRole.STAFF] } },
      select: { id: true },
    });
    if (admins.length === 0) return [];
    const results = await notifyNewConsultantApplication(
      admins.map((a) => a.id),
      {
        applicantName: applicant.name ?? "Unknown",
        applicantEmail: applicant.email ?? "",
        dashboardUrl: applicant.dashboardUrl,
      },
      { tx: prisma },
    );
    const byId = new Map<string, StagedTrigger>();
    for (const r of results) {
      if (r.success && r.staged) byId.set(r.staged.id, r.staged);
    }
    return Array.from(byId.values());
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
