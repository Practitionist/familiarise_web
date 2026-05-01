/**
 * Backfill `organizationId` on Appointment / Waitlist / Recording for the
 * #674 personal-vs-org scope split.
 *
 * Strategy:
 *   For each row whose `organizationId` is currently NULL, look up the
 *   acting user's ACTIVE Memberships. If they have exactly ONE active
 *   org membership at the time we run, stamp `organizationId` to that
 *   org. If they have zero or multiple, leave NULL (operator can
 *   re-attribute manually via the org dashboard once it ships).
 *
 *   - Appointment: acting user = the consultee on the linked
 *     Consultation / Subscription / TrialSession (relation name
 *     `requestedBy` on both Consultation and Subscription, and
 *     `consulteeProfile` on TrialSession).
 *   - Waitlist: acting user = `Waitlist.userId`.
 *   - Recording: derived from the parent Appointment.organizationId in a
 *     second pass after Appointment backfill completes (cheaper than
 *     re-deriving from membership).
 *
 * Idempotent: only updates rows where `organizationId IS NULL`.
 * Safe to run multiple times.
 *
 * Usage:
 *   npx tsx prisma/scripts/backfill-appointment-org-id.ts
 *   npx tsx prisma/scripts/backfill-appointment-org-id.ts --dry-run
 */

import prisma from "@/lib/prisma";

const DRY_RUN = process.argv.includes("--dry-run");

interface BackfillStats {
  scanned: number;
  updated: number;
  skipped: number;
}

/**
 * Resolve a user's single active org membership, if any. Returns null if
 * the user has zero or multiple active memberships.
 */
async function resolveSingleOrgForUser(userId: string): Promise<string | null> {
  const memberships = await prisma.membership.findMany({
    where: { userId, status: "ACTIVE" },
    select: { organizationId: true },
  });
  if (memberships.length !== 1) return null;
  return memberships[0].organizationId;
}

/**
 * Resolve the consultee userId for an Appointment. Joins out to the
 * linked Consultation / Subscription / TrialSession to find the
 * `requestedBy.userId` (or `consulteeProfile.userId` for trials).
 *
 * Returns null for Webinar / Class appointments — those are 1:many and
 * the umbrella Appointment row has no single "booker"; per-registrant
 * org context is captured via Payment.organizationId instead.
 */
async function resolveConsulteeUserIdForAppointment(
  appointmentId: string,
): Promise<{ userId: string | null; trialOrgId: string | null }> {
  const appt = await prisma.appointment.findUnique({
    where: { id: appointmentId },
    include: {
      consultation: {
        include: { requestedBy: { select: { userId: true } } },
      },
      subscription: {
        include: { requestedBy: { select: { userId: true } } },
      },
      trialSession: {
        include: { consulteeProfile: { select: { userId: true } } },
      },
    },
  });
  if (!appt) return { userId: null, trialOrgId: null };

  // TrialSession already has its own organizationId — short-circuit.
  if (appt.trialSession?.organizationId) {
    return { userId: null, trialOrgId: appt.trialSession.organizationId };
  }

  const userId =
    appt.consultation?.requestedBy?.userId ??
    appt.subscription?.requestedBy?.userId ??
    appt.trialSession?.consulteeProfile?.userId ??
    null;
  return { userId, trialOrgId: null };
}

async function backfillAppointments(): Promise<BackfillStats> {
  const stats: BackfillStats = { scanned: 0, updated: 0, skipped: 0 };

  const ids = await prisma.appointment.findMany({
    where: { organizationId: null },
    select: { id: true },
  });
  stats.scanned = ids.length;

  for (const { id } of ids) {
    const { userId, trialOrgId } =
      await resolveConsulteeUserIdForAppointment(id);

    let orgId: string | null = trialOrgId;
    if (!orgId && userId) {
      orgId = await resolveSingleOrgForUser(userId);
    }
    if (!orgId) {
      stats.skipped += 1;
      continue;
    }

    if (!DRY_RUN) {
      await prisma.appointment.update({
        where: { id },
        data: { organizationId: orgId },
      });
    }
    stats.updated += 1;
  }

  return stats;
}

async function backfillWaitlist(): Promise<BackfillStats> {
  const stats: BackfillStats = { scanned: 0, updated: 0, skipped: 0 };

  const rows = await prisma.waitlist.findMany({
    where: { organizationId: null },
    select: { id: true, userId: true },
  });
  stats.scanned = rows.length;

  for (const w of rows) {
    const orgId = await resolveSingleOrgForUser(w.userId);
    if (!orgId) {
      stats.skipped += 1;
      continue;
    }
    if (!DRY_RUN) {
      await prisma.waitlist.update({
        where: { id: w.id },
        data: { organizationId: orgId },
      });
    }
    stats.updated += 1;
  }

  return stats;
}

async function backfillRecordings(): Promise<BackfillStats> {
  const stats: BackfillStats = { scanned: 0, updated: 0, skipped: 0 };

  // Recording → MeetingSession → SlotOfAppointment → Appointment.
  // After Appointment.organizationId has been backfilled (above),
  // recordings just denormalize from the parent appointment.
  const rows = await prisma.recording.findMany({
    where: { organizationId: null },
    include: {
      meetingSession: {
        include: {
          slotOfAppointment: {
            include: {
              appointment: { select: { organizationId: true } },
            },
          },
        },
      },
    },
  });
  stats.scanned = rows.length;

  for (const r of rows) {
    const orgId =
      r.meetingSession?.slotOfAppointment?.appointment?.organizationId ??
      null;
    if (!orgId) {
      stats.skipped += 1;
      continue;
    }
    if (!DRY_RUN) {
      await prisma.recording.update({
        where: { id: r.id },
        data: { organizationId: orgId },
      });
    }
    stats.updated += 1;
  }

  return stats;
}

async function main() {
  console.log(
    `[backfill] Starting org-id backfill (dry-run=${DRY_RUN ? "yes" : "no"})`,
  );

  const apptStats = await backfillAppointments();
  console.log(
    `[backfill][Appointment] scanned=${apptStats.scanned} updated=${apptStats.updated} skipped=${apptStats.skipped}`,
  );

  const waitlistStats = await backfillWaitlist();
  console.log(
    `[backfill][Waitlist] scanned=${waitlistStats.scanned} updated=${waitlistStats.updated} skipped=${waitlistStats.skipped}`,
  );

  // Recordings AFTER appointments so the appointment.organizationId
  // backfill has already happened and recordings can derive from it.
  const recordingStats = await backfillRecordings();
  console.log(
    `[backfill][Recording] scanned=${recordingStats.scanned} updated=${recordingStats.updated} skipped=${recordingStats.skipped}`,
  );

  console.log(`[backfill] Done.`);
}

main()
  .catch((err) => {
    console.error("[backfill] Failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
