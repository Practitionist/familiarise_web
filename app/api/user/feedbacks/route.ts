import prisma from "lib/prisma";
import { UserRole } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";
import { notifyFeedbackReceived } from "@/lib/novu";
import { CreateFeedbackSchema } from "@/schemas/feedbacks";
import { spamLimiter, applyRateLimit } from "@/lib/rate-limit";

import { getSession } from "@/lib/auth-server";
import { supportError } from "@/lib/api/support-http";
import { assertBodySize } from "@/lib/validation/limits";
export async function GET() {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json(
        { error: "You must be logged in to access your feedback" },
        { status: 401 },
      );
    }

    const feedbacks = await prisma.platformFeedback.findMany({
      where: {
        userId: session.user.id,
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    return NextResponse.json(feedbacks);
  } catch (error) {
    console.error("Error fetching feedbacks:", error);
    return NextResponse.json(
      {
        error: "An unexpected error occurred while fetching your feedback",
      },
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json(
        { error: "You must be logged in to submit feedback" },
        { status: 401 },
      );
    }

    // Rate limit: 5 feedbacks per hour per user
    const rl = await applyRateLimit(
      spamLimiter,
      `feedbacks:${session.user.id}`,
    );
    if (rl) return rl;

    // #831 — cap request body before parsing
    const tooLarge = assertBodySize(req);
    if (tooLarge) return tooLarge;

    const body = await req.json();
    const result = CreateFeedbackSchema.safeParse(body);
    if (!result.success) {
      return supportError({
        status: 400,
        code: "VALIDATION_FAILED",
        detail: result.error.flatten(),
        context: { route: "user.feedbacks", action: "create" },
      });
    }
    const validatedData = result.data;

    const feedback = await prisma.platformFeedback.create({
      data: {
        title: validatedData.title,
        description: validatedData.description,
        rating: validatedData.rating,
        category: validatedData.category,
        user: { connect: { id: session.user.id } },
      },
    });

    try {
      const adminUsers = await prisma.user.findMany({
        where: { role: { in: ["STAFF", "ADMIN"] } },
        select: { id: true, role: true },
      });
      const feedbackPayload = {
        feedbackId: feedback.id,
        userName: session.user.name || "Someone",
        category: feedback.category || undefined,
        message: feedback.description || feedback.title || "New feedback",
      };
      await Promise.allSettled(
        adminUsers.map((u) => {
          const queue =
            u.role === UserRole.ADMIN
              ? "/dashboard/admin/feedback"
              : "/dashboard/staff/feedback";
          return notifyFeedbackReceived([u.id], {
            ...feedbackPayload,
            dashboardUrl: queue,
          });
        }),
      );
    } catch (notifyError) {
      console.error("Failed to dispatch feedback notifications:", notifyError);
    }

    return NextResponse.json(feedback, { status: 201 });
  } catch (error) {
    console.error("Error creating feedback:", error);
    return NextResponse.json(
      {
        error: "An unexpected error occurred while submitting your feedback",
      },
      { status: 500 },
    );
  }
}
