import { moderationDeadline } from "@/lib/support/deadline-policy";
/**
 * User-facing Content Report API
 * Allows users to report inappropriate content
 */

import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { ModerationReportType, type Prisma } from "@prisma/client";
import { spamLimiter, applyRateLimit } from "@/lib/rate-limit";
import { assertBodySize } from "@/lib/validation/limits";
import { CreateReportSchema } from "@/schemas/moderation";

import { getSession } from "@/lib/auth-server";
import {
  getStreamChatClient,
  withStreamCircuitBreaker,
} from "@/lib/stream-client";
import { streamLogger } from "@/lib/stream-logger";
import { isUniqueViolation } from "@/lib/db/pg-errors";
import { formatReportReference } from "@/lib/moderation/report-reference";
import { readJsonBody } from "@/lib/api/parse";

// Normalize content identity before deduplication and storage.
function contentScopeFor(
  type: ModerationReportType,
  reviewId: string | null,
  streamMessageId: string | null,
): Prisma.ModerationReportWhereInput {
  return {
    reviewId: type === "REVIEW" ? reviewId : null,
    streamMessageId: type === "MESSAGE" ? streamMessageId : null,
  };
}

async function resolveReportedMessage(
  streamMessageId: string,
  targetUserId: string,
  reporterUserId: string,
) {
  try {
    const client = getStreamChatClient();
    const { message } = await withStreamCircuitBreaker(() =>
      client.getMessage(streamMessageId),
    );
    if (!message?.cid || message.user?.id !== targetUserId) {
      return {
        error: "The reported message could not be verified",
        status: 403,
      };
    }
    // Server credentials bypass channel permissions; require the reporter's membership explicitly.
    // `cid` is captured because a property narrowing does not survive into a closure.
    const cid = message.cid;
    const channels = await withStreamCircuitBreaker(() =>
      client.queryChannels(
        { cid: { $eq: cid }, members: { $in: [reporterUserId] } },
        {},
        { limit: 1, state: false, watch: false },
      ),
    );
    const channel = channels[0];
    if (!channel) {
      return {
        error: "The reported message could not be verified",
        status: 403,
      };
    }
    // The organisation is a custom channel field the enterprise wiring writes at
    // creation time; the SDK's channel type does not declare it.
    const channelData = channel.data as Record<string, unknown> | undefined;
    const channelCustom = channelData?.custom as
      Record<string, unknown> | undefined;
    const organization = channelCustom?.organization_id;
    return {
      data: {
        streamMessageId: message.id,
        streamChannelCid: message.cid,
        messageText: message.text || null,
        organizationId: typeof organization === "string" ? organization : null,
      },
    };
  } catch (error) {
    streamLogger.warn("Could not verify a reported Stream message", {
      streamMessageId,
      error: String(error),
    });
    return {
      error: "Message verification is unavailable; please retry",
      status: 503,
    };
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Rate limit: 5 reports per hour per user
    const rl = await applyRateLimit(spamLimiter, `report:${session.user.id}`);
    if (rl) return rl;

    const tooLarge = assertBodySize(req);
    if (tooLarge) return tooLarge;

    const read = await readJsonBody(req);
    if (read.error) return read.error;
    const body = read.body;
    const parsed = CreateReportSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Validation failed", details: parsed.error.issues },
        { status: 400 },
      );
    }
    const {
      type,
      reason,
      description,
      targetUserId,
      contentText,
      contentUrl,
      reviewId,
      organizationId: callerOrganizationId,
      streamMessageId,
    } = parsed.data;

    // Validate required fields
    if (!type || !reason || (type !== "REVIEW" && !targetUserId)) {
      return NextResponse.json(
        { error: "Type, reason, and targetUserId are required" },
        { status: 400 },
      );
    }

    // Validate type
    const validTypes: ModerationReportType[] = [
      "REVIEW",
      "PROFILE",
      "MESSAGE",
      "DOCUMENT",
      "OTHER",
    ];
    if (!validTypes.includes(type)) {
      return NextResponse.json(
        { error: "Invalid report type" },
        { status: 400 },
      );
    }

    // The content a report points at is derived from its TYPE, never stored as
    // sent: a PROFILE report carrying somebody's review id used to let "Remove
    // content" soft-delete that review. Only a REVIEW report keeps a reviewId,
    // only a MESSAGE report keeps a message identity, and the rest keep neither.
    let target = targetUserId ?? "";
    let reportedReviewId: string | null = null;
    let resolvedOrganizationId: string | null = null;
    let reviewSnapshotText: string | null = null;
    if (type === "REVIEW") {
      if (!reviewId) {
        return NextResponse.json(
          { error: "A review report must name the review" },
          { status: 400 },
        );
      }
      const reported = await prisma.consultantReview.findFirst({
        where: { id: reviewId, deletedAt: null },
        select: {
          reviewDescription: true,
          consultantProfile: { select: { userId: true } },
          consulteeProfile: { select: { userId: true } },
          appointment: { select: { organizationId: true } },
        },
      });
      if (!reported) {
        return NextResponse.json(
          { error: "Review not found" },
          { status: 404 },
        );
      }
      const consultantUserId = reported.consultantProfile?.userId;
      const hostOrgId = reported.appointment?.organizationId ?? null;
      if (consultantUserId !== session.user.id) {
        const isHostOrgAdmin = hostOrgId
          ? Boolean(
              await prisma.membership.findFirst({
                where: {
                  organizationId: hostOrgId,
                  userId: session.user.id,
                  status: "ACTIVE",
                  role: { in: ["OWNER", "MAINTAINER"] },
                },
                select: { id: true },
              }),
            )
          : false;
        if (!isHostOrgAdmin) {
          return NextResponse.json(
            {
              error:
                "Only the reviewed consultant or an active host organization admin can report this review",
            },
            { status: 403 },
          );
        }
      }
      target = reported.consulteeProfile.userId;
      reportedReviewId = reviewId;
      resolvedOrganizationId = hostOrgId;
      reviewSnapshotText = reported.reviewDescription ?? null;
    }

    const verifiedMessage: {
      streamMessageId: string | null;
      streamChannelCid: string | null;
      messageText: string | null;
    } = { streamMessageId: null, streamChannelCid: null, messageText: null };
    if (type === "MESSAGE") {
      if (!streamMessageId) {
        return NextResponse.json(
          { error: "A message report must name the message" },
          { status: 400 },
        );
      }
      const resolved = await resolveReportedMessage(
        streamMessageId,
        target,
        session.user.id,
      );
      if ("error" in resolved) {
        return NextResponse.json(
          { error: resolved.error },
          { status: resolved.status },
        );
      }
      Object.assign(verifiedMessage, resolved.data);
      resolvedOrganizationId = resolved.data.organizationId;
    }
    // Organization attribution comes only from the reported review or canonical channel.
    if (
      callerOrganizationId &&
      callerOrganizationId !== resolvedOrganizationId
    ) {
      return NextResponse.json(
        { error: "Organization does not match the reported content" },
        { status: 403 },
      );
    }

    // Prevent self-reporting
    if (target === session.user.id) {
      return NextResponse.json(
        { error: "You cannot report yourself" },
        { status: 400 },
      );
    }

    // Check if target user exists
    const targetUser = await prisma.user.findUnique({
      where: { id: target },
    });

    if (!targetUser) {
      return NextResponse.json(
        { error: "Target user not found" },
        { status: 404 },
      );
    }

    const contentScope = contentScopeFor(
      type,
      reportedReviewId,
      verifiedMessage.streamMessageId,
    );

    // Check for existing report from same user for same content
    const existingReport = await prisma.moderationReport.findFirst({
      where: {
        reportedById: session.user.id,
        targetUserId: target,
        type,
        ...contentScope,
        status: { in: ["PENDING", "UNDER_REVIEW", "ESCALATED"] },
      },
    });

    if (existingReport) {
      return NextResponse.json(
        {
          error: "You have already reported this content",
          reportId: existingReport.id,
          reportReference: formatReportReference(existingReport.id),
        },
        { status: 409 },
      );
    }

    let effectiveContentText = contentText;
    if (type === "REVIEW") {
      effectiveContentText = reviewSnapshotText ?? undefined;
    } else if (type === "MESSAGE") {
      effectiveContentText = verifiedMessage.messageText ?? undefined;
    }

    // Create new report
    const report = await prisma.moderationReport.create({
      data: {
        type,
        reason,
        description,
        ...moderationDeadline(reason, new Date()),
        reportedById: session.user.id,
        targetUserId: target,
        contentText: effectiveContentText,
        contentUrl,
        reviewId: reportedReviewId,
        organizationId: resolvedOrganizationId,
        streamMessageId: verifiedMessage.streamMessageId,
        streamChannelCid: verifiedMessage.streamChannelCid,
      },
    });

    return NextResponse.json(
      {
        message: "Report submitted successfully",
        reportId: report.id,
        reportReference: formatReportReference(report.id),
      },
      { status: 201 },
    );
  } catch (error) {
    if (isUniqueViolation(error)) {
      return NextResponse.json(
        {
          error: "You have already reported this content; reload your reports",
        },
        { status: 409 },
      );
    }
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "report" } },
    );
    console.error("Error submitting report:", error);
    return NextResponse.json(
      { error: "Failed to submit report" },
      { status: 500 },
    );
  }
}
