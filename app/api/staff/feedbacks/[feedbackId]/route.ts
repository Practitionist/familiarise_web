import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import prisma from "lib/prisma";

import { requirePrivilegedAuth } from "@/lib/auth-helpers";
import { STAFF_FEEDBACK_SELECT } from "@/lib/backoffice/staff-feedback";
import { goHref } from "@/lib/dashboard/go";
import { stageFeedbackUpdateEmail } from "@/lib/email/senders/people";
import { stageBell } from "@/lib/novu/stage-bell";
import { flushNotificationsAfter } from "@/lib/novu/stage-then-attempt";
import { NOVU_WORKFLOWS } from "@/lib/novu/workflows";
import { PatchFeedbackSchema } from "@/schemas/moderation";

const patchFeedbackSchema = PatchFeedbackSchema.strict();

/**
 * An absent note leaves the stored one alone; an empty one clears it. The
 * schema has already trimmed it.
 */
function parseStaffNote(raw: string | undefined): string | null | undefined {
  if (raw === undefined) return undefined;
  return raw.length > 0 ? raw : null;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ feedbackId: string }> },
) {
  try {
    const auth = await requirePrivilegedAuth();
    if (auth.error) return auth.error;

    const { feedbackId } = await params;

    const feedback = await prisma.platformFeedback.findUnique({
      where: { id: feedbackId },
      select: STAFF_FEEDBACK_SELECT,
    });

    if (!feedback) {
      return NextResponse.json(
        { error: "Feedback not found" },
        { status: 404 },
      );
    }

    return NextResponse.json(feedback);
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "staff" } },
    );
    console.error("Error fetching feedback:", error);
    return NextResponse.json(
      { error: "Failed to fetch feedback" },
      { status: 500 },
    );
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ feedbackId: string }> },
) {
  try {
    const auth = await requirePrivilegedAuth();
    if (auth.error) return auth.error;

    const { feedbackId } = await params;
    const parsed = patchFeedbackSchema.safeParse(
      await req.json().catch(() => null),
    );
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid status or note" },
        { status: 400 },
      );
    }

    const nextStatus = parsed.data.status;
    // The operator's own note. It is written by the same PATCH that moves the
    // status, so a note and a status never disagree about what was done.
    const staffNote = parseStaffNote(parsed.data.staffNote);

    const result = await prisma.$transaction(async (tx) => {
      const existing = await tx.platformFeedback.findUnique({
        where: { id: feedbackId },
        select: {
          id: true,
          status: true,
          userId: true,
          title: true,
          staffNote: true,
        },
      });
      if (!existing) {
        return { kind: "not_found" as const };
      }

      const statusChanged = existing.status !== nextStatus;
      const noteChanged =
        staffNote !== undefined && staffNote !== existing.staffNote;

      if (statusChanged || noteChanged) {
        // CAS'd on the status we read: a concurrent write to the same row
        // loses the guard and the caller is told, rather than one write
        // silently overwriting the other's.
        const updated = await tx.platformFeedback.updateMany({
          where: { id: feedbackId, status: existing.status },
          data: {
            ...(statusChanged ? { status: nextStatus } : {}),
            ...(noteChanged ? { staffNote } : {}),
          },
        });
        if (updated.count === 0) {
          return { kind: "conflict" as const };
        }
      }

      const dashboardUrl = goHref("auto", "feedbacks");
      const stagedBell = statusChanged
        ? await stageBell(tx, {
            workflowId: NOVU_WORKFLOWS.PLATFORM_FEEDBACK_UPDATE,
            recipients: [existing.userId],
            payload: {
              feedbackId,
              status: nextStatus,
              dashboardUrl,
            },
            dedupeKey: `platform-feedback:${feedbackId}:${existing.status}->${nextStatus}:${Date.now()}`,
          })
        : null;

      const feedback = await tx.platformFeedback.findUniqueOrThrow({
        where: { id: feedbackId },
        select: STAFF_FEEDBACK_SELECT,
      });

      return {
        kind: "ok" as const,
        feedback,
        stagedBell,
        emailArgs: statusChanged
          ? {
              feedbackId,
              userId: existing.userId,
              title: existing.title ?? undefined,
              statusLabel: nextStatus.toLowerCase().replace(/_/g, " "),
              dashboardUrl,
            }
          : null,
      };
    });

    if (result.kind === "not_found") {
      return NextResponse.json(
        { error: "Feedback not found" },
        { status: 404 },
      );
    }

    if (result.kind === "conflict") {
      return NextResponse.json(
        { error: "Feedback status was modified concurrently" },
        { status: 409 },
      );
    }

    const stagedEmails = result.emailArgs
      ? await stageFeedbackUpdateEmail(prisma, result.emailArgs).catch(
          (err) => {
            console.error("[staff.feedback] email stage failed:", err);
            return [];
          },
        )
      : [];

    await flushNotificationsAfter(
      {
        bells: [result.stagedBell],
        emails: [
          {
            rows: stagedEmails,
            emailType: "PLATFORM_FEEDBACK_UPDATE",
          },
        ],
      },
      "staff.feedback.patch",
    );

    return NextResponse.json(result.feedback);
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "staff" } },
    );
    console.error("Error updating feedback:", error);
    return NextResponse.json(
      { error: "Failed to update feedback" },
      { status: 500 },
    );
  }
}
