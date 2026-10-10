import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import prisma from "lib/prisma";

import { requirePrivilegedAuth } from "@/lib/auth-helpers";
import { goHref } from "@/lib/dashboard/go";
import { attemptTrigger } from "@/lib/novu/outbox";
import { stageBell } from "@/lib/novu/stage-bell";
import { NOVU_WORKFLOWS } from "@/lib/novu/workflows";
import { PatchFeedbackSchema } from "@/schemas/moderation";

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
        select: { id: true, status: true, userId: true },
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

      const stagedBell =
        existing.status !== nextStatus
          ? await stageBell(tx, {
              workflowId: NOVU_WORKFLOWS.PLATFORM_FEEDBACK_UPDATE,
              recipients: [existing.userId],
              payload: {
                feedbackId,
                status: nextStatus,
                dashboardUrl: goHref("auto", "feedbacks"),
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

      return { kind: "ok" as const, feedback, stagedBell };
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

    if (result.stagedBell) {
      await attemptTrigger(result.stagedBell);
    }

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
