/**
 * Verification housekeeping (PR-5 of the onboarding train). Three sweeps in
 * one daily job, each idempotent:
 *
 *   1. Unlinked uploads older than UNLINKED_UPLOAD_TTL_DAYS — the object and
 *      the row go; an upload nobody submitted is storage cost, not evidence.
 *   2. NEEDS_INFO requests unanswered for 7 days — one reminder email, stamped
 *      on `reminderSentAt` so it never repeats.
 *   3. NEEDS_INFO requests unanswered for 14 days — closed as REJECTED with a
 *      reason the consultant can act on; profile follows; decision email.
 *
 * Imported by jobs/cleanup/sweep-verification.ts (GitHub Actions) and
 * app/api/cleanup/sweep-verification/route.ts (HTTP twin).
 * See docs/onboarding/04-verification-lifecycle.md.
 */

import prisma from "../../lib/prisma";
import { withCronLock } from "@/lib/cron/with-cron-lock";
// The leaf module, NOT `@/lib/supabase` — that one carries `server-only`,
// which a bare `tsx jobs/...` process cannot evaluate (#1270).
import { supabaseAdmin } from "@/lib/supabase-storage-core";
import { UNLINKED_UPLOAD_TTL_DAYS } from "@/lib/verification/documents";
import {
  attemptOnboardingEmail,
  stageVerificationDecidedEmail,
} from "@/lib/email";
import { attemptTrigger, notifyVerificationStatusChanged } from "@/lib/novu";

export const NEEDS_INFO_REMINDER_DAYS = 7;
export const NEEDS_INFO_CLOSE_DAYS = 14;
export const NO_RESPONSE_REASON =
  "No response to the reviewer's request within 14 days. Submit again from Settings → Verification when you are ready.";

export interface SweepVerificationResult {
  unlinkedDeleted: number;
  remindersSent: number;
  staleClosed: number;
  errors: string[];
  success: boolean;
}

const BATCH = 200;
const daysAgo = (days: number, now: Date) =>
  new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

async function sweepUnlinkedUploads(
  now: Date,
  errors: string[],
): Promise<number> {
  const rows = await prisma.profileVerificationDocument.findMany({
    where: {
      verificationId: null,
      uploadedAt: { lt: daysAgo(UNLINKED_UPLOAD_TTL_DAYS, now) },
    },
    select: { id: true, storagePath: true },
    take: BATCH,
  });
  let deleted = 0;
  for (const row of rows) {
    try {
      // Object first: a row without an object is harmless, an object without
      // a row is the orphan this sweep exists to remove.
      if (!supabaseAdmin) throw new Error("SUPABASE_SERVICE_ROLE_KEY not set");
      const { error } = await supabaseAdmin.storage
        .from("documents")
        .remove([row.storagePath]);
      if (error) throw error;
      await prisma.profileVerificationDocument.deleteMany({
        where: { id: row.id, verificationId: null },
      });
      deleted += 1;
    } catch (error) {
      errors.push(`unlinked ${row.id}: ${String(error)}`);
    }
  }
  return deleted;
}

async function remindUnanswered(now: Date, errors: string[]): Promise<number> {
  const rows = await prisma.consultantProfileVerification.findMany({
    where: {
      status: "NEEDS_INFO",
      reminderSentAt: null,
      reviewedAt: {
        lt: daysAgo(NEEDS_INFO_REMINDER_DAYS, now),
        gte: daysAgo(NEEDS_INFO_CLOSE_DAYS, now),
      },
    },
    select: {
      id: true,
      rejectionReason: true,
      feedbackDetails: true,
      consultantProfile: { select: { id: true, userId: true } },
    },
    take: BATCH,
  });
  let sent = 0;
  for (const row of rows) {
    try {
      // Stamp first (CAS on the null) so a concurrent run cannot send twice.
      const stamped = await prisma.consultantProfileVerification.updateMany({
        where: { id: row.id, reminderSentAt: null },
        data: { reminderSentAt: now },
      });
      if (stamped.count === 0) continue;
      const staged = await stageVerificationDecidedEmail({
        userId: row.consultantProfile.userId,
        verificationId: row.id,
        status: "NEEDS_INFO_REMINDER",
        reason: row.rejectionReason || row.feedbackDetails || undefined,
        dashboardUrl: `/dashboard/consultant/${row.consultantProfile.id}/settings`,
        daysLeft: NEEDS_INFO_CLOSE_DAYS - NEEDS_INFO_REMINDER_DAYS,
      });
      await attemptOnboardingEmail(staged);
      sent += 1;
    } catch (error) {
      errors.push(`remind ${row.id}: ${String(error)}`);
    }
  }
  return sent;
}

async function closeStale(now: Date, errors: string[]): Promise<number> {
  const rows = await prisma.consultantProfileVerification.findMany({
    where: {
      status: "NEEDS_INFO",
      reviewedAt: { lt: daysAgo(NEEDS_INFO_CLOSE_DAYS, now) },
    },
    select: {
      id: true,
      consultantProfile: { select: { id: true, userId: true } },
    },
    take: BATCH,
  });
  let closed = 0;
  for (const row of rows) {
    try {
      const done = await prisma.$transaction(async (tx) => {
        const flipped = await tx.consultantProfileVerification.updateMany({
          where: { id: row.id, status: "NEEDS_INFO" },
          data: {
            status: "REJECTED",
            rejectionReason: NO_RESPONSE_REASON,
            // reviewedAt keeps the staff decision time; the close is the sweep's.
          },
        });
        if (flipped.count === 0) return false;
        await tx.consultantProfile.update({
          where: { id: row.consultantProfile.id },
          data: { verificationStatus: "REJECTED", isVerified: false },
        });
        return true;
      });
      if (!done) continue;
      // No public-surface purge: a NEEDS_INFO consultant was never listed.
      const payload = {
        status: "REJECTED" as const,
        reason: NO_RESPONSE_REASON,
        dashboardUrl: `/dashboard/consultant/${row.consultantProfile.id}/settings`,
      };
      const bell = await notifyVerificationStatusChanged(
        row.consultantProfile.userId,
        payload,
        { tx: prisma },
      );
      if (bell.success && bell.staged) await attemptTrigger(bell.staged);
      const staged = await stageVerificationDecidedEmail({
        userId: row.consultantProfile.userId,
        verificationId: row.id,
        status: "REJECTED",
        reason: NO_RESPONSE_REASON,
        dashboardUrl: payload.dashboardUrl,
      });
      await attemptOnboardingEmail(staged);
      closed += 1;
    } catch (error) {
      errors.push(`close ${row.id}: ${String(error)}`);
    }
  }
  return closed;
}

export async function sweepVerification(
  now: Date = new Date(),
): Promise<SweepVerificationResult> {
  return withCronLock("sweep-verification", { failMode: "open" }, async () => {
    const errors: string[] = [];
    const unlinkedDeleted = await sweepUnlinkedUploads(now, errors);
    const remindersSent = await remindUnanswered(now, errors);
    const staleClosed = await closeStale(now, errors);
    return {
      unlinkedDeleted,
      remindersSent,
      staleClosed,
      errors,
      success: errors.length === 0,
    };
  });
}

export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
}
