import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import prisma from "lib/prisma";

import { requirePrivilegedAuth } from "@/lib/auth-helpers";
import { goHref } from "@/lib/dashboard/go";
import { stageFeedbackUpdateEmail } from "@/lib/email/senders/people";
import { stageBell } from "@/lib/novu/stage-bell";
import { flushNotificationsAfter } from "@/lib/novu/stage-then-attempt";
import { NOVU_WORKFLOWS } from "@/lib/novu/workflows";
import { PatchFeedbackSchema } from "@/schemas/moderation";
import { PLATFORM_FEEDBACK_STATUS_LABEL } from "@/lib/labels/session-labels";

const patchFeedbackSchema = PatchFeedbackSchema.strict();

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
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            image: true,
            phone: true,
            createdAt: true,
          },
        },
      },
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
      return NextResponse.json({ error: "Invalid status" }, { status: 400 });
    }

    const nextStatus = parsed.data.status;

    const result = await prisma.$transaction(async (tx) => {
      const existing = await tx.platformFeedback.findUnique({
        where: { id: feedbackId },
        select: { id: true, status: true, userId: true, title: true },
      });
      if (!existing) {
        return { kind: "not_found" as const };
      }

      if (existing.status !== nextStatus) {
        const updated = await tx.platformFeedback.updateMany({
          where: { id: feedbackId, status: existing.status },
          data: { status: nextStatus },
        });
        if (updated.count === 0) {
          return { kind: "conflict" as const };
        }
      }

      const statusChanged = existing.status !== nextStatus;
      const dashboardUrl = goHref("auto", "support/feedback");
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
        include: {
          user: {
            select: {
              id: true,
              name: true,
              email: true,
              image: true,
            },
          },
        },
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
              statusLabel:
                PLATFORM_FEEDBACK_STATUS_LABEL[nextStatus].toLowerCase(),
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
