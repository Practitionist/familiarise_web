import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getSession } from "@/lib/auth-server";
import {
  uploadPlanImage,
  deletePlanImage,
  type TPlanImageType,
} from "@/lib/supabase";
import { apiError } from "@/lib/errors";
import { z } from "zod";

const planImageSchema = z.object({
  planType: z.enum(["webinar-plans", "class-plans"]),
  planId: z.string().min(1),
});

export async function POST(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const formData = await request.formData();
    const file = formData.get("file") as File | null;

    if (!file) {
      return NextResponse.json(
        { error: "Missing required field: file" },
        { status: 400 },
      );
    }

    const parseResult = planImageSchema.safeParse({
      planType: formData.get("planType"),
      planId: formData.get("planId"),
    });

    if (!parseResult.success) {
      return NextResponse.json(
        { error: "Invalid request", details: parseResult.error.format() },
        { status: 400 },
      );
    }

    const { planType, planId } = parseResult.data;

    // Verify plan ownership
    const isOwner = await verifyPlanOwnership(
      planType,
      planId,
      session.user.id,
    );
    if (!isOwner) {
      return NextResponse.json(
        { error: "You don't have permission to modify this plan" },
        { status: 403 },
      );
    }

    // Upload image
    const result = await uploadPlanImage({ planType, planId, file });

    if (!result.success || !result.fileUrl) {
      return NextResponse.json(
        { error: result.error || "Upload failed" },
        { status: 500 },
      );
    }

    // Update Prisma record with imageUrl
    if (planType === "class-plans") {
      await prisma.classPlan.update({
        where: { id: planId },
        data: { imageUrl: result.fileUrl },
      });
    } else {
      await prisma.webinarPlan.update({
        where: { id: planId },
        data: { imageUrl: result.fileUrl },
      });
    }

    return NextResponse.json({ imageUrl: result.fileUrl }, { status: 200 });
  } catch (error) {
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "bookings" } });
    return apiError({ tag: "[PlanImage.POST]", error });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const parseResult = planImageSchema.safeParse(body);

    if (!parseResult.success) {
      return NextResponse.json(
        { error: "Invalid request body", details: parseResult.error.format() },
        { status: 400 },
      );
    }

    const { planType, planId } = parseResult.data;

    // Verify plan ownership
    const isOwner = await verifyPlanOwnership(
      planType,
      planId,
      session.user.id,
    );
    if (!isOwner) {
      return NextResponse.json(
        { error: "You don't have permission to modify this plan" },
        { status: 403 },
      );
    }

    // Delete from storage
    const deleted = await deletePlanImage(planType, planId);
    if (!deleted) {
      return NextResponse.json(
        { error: "Failed to delete image from storage" },
        { status: 500 },
      );
    }

    // Set imageUrl to null in DB
    if (planType === "class-plans") {
      await prisma.classPlan.update({
        where: { id: planId },
        data: { imageUrl: null },
      });
    } else {
      await prisma.webinarPlan.update({
        where: { id: planId },
        data: { imageUrl: null },
      });
    }

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (error) {
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "bookings" } });
    return apiError({ tag: "[PlanImage.DELETE]", error });
  }
}

async function verifyPlanOwnership(
  planType: TPlanImageType,
  planId: string,
  userId: string,
): Promise<boolean> {
  // Exhaustive on TPlanImageType: adding a plan type without an ownership
  // check here is a compile error rather than a silent upload someone else can
  // overwrite.
  const ownerSelect = {
    where: { id: planId },
    select: { consultantProfile: { select: { userId: true } } },
  } as const;

  switch (planType) {
    case "class-plans": {
      const plan = await prisma.classPlan.findUnique(ownerSelect);
      return plan?.consultantProfile?.userId === userId;
    }
    case "webinar-plans": {
      const plan = await prisma.webinarPlan.findUnique(ownerSelect);
      return plan?.consultantProfile?.userId === userId;
    }
    case "consultation-plans": {
      const plan = await prisma.consultationPlan.findUnique(ownerSelect);
      return plan?.consultantProfile?.userId === userId;
    }
    case "subscription-plans": {
      const plan = await prisma.subscriptionPlan.findUnique(ownerSelect);
      return plan?.consultantProfile?.userId === userId;
    }
  }
}
