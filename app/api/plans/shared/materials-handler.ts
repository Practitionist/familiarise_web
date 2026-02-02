import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getSession } from "@/lib/auth-server";
import {
  uploadPlanMaterial,
  deletePlanMaterial,
  type PlanType,
} from "@/lib/supabase";

// Type definitions
export interface PlanMaterialsConfig {
  planType: PlanType;
  planIdField: string;
  planModel:
    | "consultationPlan"
    | "subscriptionPlan"
    | "webinarPlan"
    | "classPlan";
}

// Development mode check
const isDevelopment = () =>
  process.env.NODE_ENV === "development" &&
  process.env.DEV_BYPASS_AUTH === "true";

/**
 * Verify the user is the consultant who owns the plan
 */
async function verifyPlanOwnership(
  userId: string,
  planId: string,
  config: PlanMaterialsConfig,
): Promise<{ isOwner: boolean; error?: string }> {
  if (isDevelopment()) {
    return { isOwner: true };
  }

  try {
    const planQuery: Record<string, unknown> = {
      where: {
        id: planId,
        consultantProfile: {
          user: {
            id: userId,
          },
        },
      },
    };

    let plan;
    switch (config.planModel) {
      case "consultationPlan":
        plan = await prisma.consultationPlan.findFirst(
          planQuery as Parameters<typeof prisma.consultationPlan.findFirst>[0],
        );
        break;
      case "subscriptionPlan":
        plan = await prisma.subscriptionPlan.findFirst(
          planQuery as Parameters<typeof prisma.subscriptionPlan.findFirst>[0],
        );
        break;
      case "webinarPlan":
        plan = await prisma.webinarPlan.findFirst(
          planQuery as Parameters<typeof prisma.webinarPlan.findFirst>[0],
        );
        break;
      case "classPlan":
        plan = await prisma.classPlan.findFirst(
          planQuery as Parameters<typeof prisma.classPlan.findFirst>[0],
        );
        break;
    }

    if (!plan) {
      return {
        isOwner: false,
        error: "Plan not found or you don't have permission to access it",
      };
    }

    return { isOwner: true };
  } catch (error) {
    console.error("Error verifying plan ownership:", error);
    return { isOwner: false, error: "Failed to verify plan ownership" };
  }
}

/**
 * GET - List materials for a plan
 */
export async function handleGetMaterials(
  request: NextRequest,
  planId: string,
  config: PlanMaterialsConfig,
): Promise<NextResponse> {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json(
        {
          error: "Authentication required",
          message: "Please sign in to view materials",
          code: "UNAUTHORIZED",
        },
        { status: 401 },
      );
    }

    // Verify ownership
    const { isOwner, error } = await verifyPlanOwnership(
      session.user.id,
      planId,
      config,
    );
    if (!isOwner) {
      return NextResponse.json(
        {
          error: "Access denied",
          message: error || "You don't have permission to view these materials",
          code: "FORBIDDEN",
        },
        { status: 403 },
      );
    }

    // Fetch materials
    const whereClause: Record<string, string> = {};
    whereClause[config.planIdField] = planId;

    const materials = await prisma.planMaterial.findMany({
      where: whereClause,
      orderBy: { order: "asc" },
    });

    return NextResponse.json({ data: materials });
  } catch (error) {
    console.error("Error fetching materials:", error);
    return NextResponse.json(
      {
        error: "Server error",
        message: "Failed to fetch materials",
        code: "SERVER_ERROR",
      },
      { status: 500 },
    );
  }
}

/**
 * POST - Upload a new material
 */
export async function handleUploadMaterial(
  request: NextRequest,
  planId: string,
  config: PlanMaterialsConfig,
): Promise<NextResponse> {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json(
        {
          error: "Authentication required",
          message: "Please sign in to upload materials",
          code: "UNAUTHORIZED",
        },
        { status: 401 },
      );
    }

    // Verify ownership
    const { isOwner, error } = await verifyPlanOwnership(
      session.user.id,
      planId,
      config,
    );
    if (!isOwner) {
      return NextResponse.json(
        {
          error: "Access denied",
          message:
            error ||
            "You don't have permission to upload materials to this plan",
          code: "FORBIDDEN",
        },
        { status: 403 },
      );
    }

    // Parse form data
    const formData = await request.formData();
    const file = formData.get("file") as File | null;
    const description = formData.get("description") as string | null;

    if (!file) {
      return NextResponse.json(
        {
          error: "No file provided",
          message: "Please select a file to upload",
          code: "INVALID_INPUT",
        },
        { status: 400 },
      );
    }

    // Upload to Supabase
    const uploadResult = await uploadPlanMaterial({
      planType: config.planType,
      planId,
      file,
      description: description || undefined,
    });

    if (!uploadResult.success) {
      return NextResponse.json(
        {
          error: "Upload failed",
          message: uploadResult.error || "Failed to upload file",
          code: "UPLOAD_ERROR",
        },
        { status: 500 },
      );
    }

    // Get the current max order for this plan
    const whereClause: Record<string, string> = {};
    whereClause[config.planIdField] = planId;

    const maxOrderResult = await prisma.planMaterial.aggregate({
      where: whereClause,
      _max: { order: true },
    });
    const nextOrder = (maxOrderResult._max.order ?? -1) + 1;

    // Create database record
    const createData: Record<string, unknown> = {
      fileName: uploadResult.fileName!,
      originalName: file.name,
      fileSize: uploadResult.fileSize!,
      mimeType: uploadResult.mimeType!,
      fileUrl: uploadResult.fileUrl!,
      storagePath: uploadResult.storagePath!,
      description: description || null,
      order: nextOrder,
    };
    createData[config.planIdField] = planId;

    const material = await prisma.planMaterial.create({
      data: createData as Parameters<
        typeof prisma.planMaterial.create
      >[0]["data"],
    });

    return NextResponse.json({ data: material }, { status: 201 });
  } catch (error) {
    console.error("Error uploading material:", error);
    return NextResponse.json(
      {
        error: "Server error",
        message: "Failed to upload material",
        code: "SERVER_ERROR",
      },
      { status: 500 },
    );
  }
}

/**
 * DELETE - Delete a material by ID
 */
export async function handleDeleteMaterial(
  request: NextRequest,
  materialId: string,
): Promise<NextResponse> {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json(
        {
          error: "Authentication required",
          message: "Please sign in to delete materials",
          code: "UNAUTHORIZED",
        },
        { status: 401 },
      );
    }

    // Find the material and verify ownership
    const material = await prisma.planMaterial.findUnique({
      where: { id: materialId },
      include: {
        consultationPlan: {
          include: {
            consultantProfile: {
              select: { userId: true },
            },
          },
        },
        subscriptionPlan: {
          include: {
            consultantProfile: {
              select: { userId: true },
            },
          },
        },
        webinarPlan: {
          include: {
            consultantProfile: {
              select: { userId: true },
            },
          },
        },
        classPlan: {
          include: {
            consultantProfile: {
              select: { userId: true },
            },
          },
        },
      },
    });

    if (!material) {
      return NextResponse.json(
        {
          error: "Material not found",
          message: "The requested material does not exist",
          code: "NOT_FOUND",
        },
        { status: 404 },
      );
    }

    // Check ownership
    const ownerUserId =
      material.consultationPlan?.consultantProfile?.userId ||
      material.subscriptionPlan?.consultantProfile?.userId ||
      material.webinarPlan?.consultantProfile?.userId ||
      material.classPlan?.consultantProfile?.userId;

    if (!isDevelopment() && ownerUserId !== session.user.id) {
      return NextResponse.json(
        {
          error: "Access denied",
          message: "You don't have permission to delete this material",
          code: "FORBIDDEN",
        },
        { status: 403 },
      );
    }

    // Delete from Supabase storage
    await deletePlanMaterial(material.storagePath);

    // Delete from database
    await prisma.planMaterial.delete({
      where: { id: materialId },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Error deleting material:", error);
    return NextResponse.json(
      {
        error: "Server error",
        message: "Failed to delete material",
        code: "SERVER_ERROR",
      },
      { status: 500 },
    );
  }
}

/**
 * PATCH - Update material order or description
 */
export async function handleUpdateMaterial(
  request: NextRequest,
  materialId: string,
): Promise<NextResponse> {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json(
        {
          error: "Authentication required",
          message: "Please sign in to update materials",
          code: "UNAUTHORIZED",
        },
        { status: 401 },
      );
    }

    // Find the material and verify ownership
    const material = await prisma.planMaterial.findUnique({
      where: { id: materialId },
      include: {
        consultationPlan: {
          include: {
            consultantProfile: {
              select: { userId: true },
            },
          },
        },
        subscriptionPlan: {
          include: {
            consultantProfile: {
              select: { userId: true },
            },
          },
        },
        webinarPlan: {
          include: {
            consultantProfile: {
              select: { userId: true },
            },
          },
        },
        classPlan: {
          include: {
            consultantProfile: {
              select: { userId: true },
            },
          },
        },
      },
    });

    if (!material) {
      return NextResponse.json(
        {
          error: "Material not found",
          message: "The requested material does not exist",
          code: "NOT_FOUND",
        },
        { status: 404 },
      );
    }

    // Check ownership
    const ownerUserId =
      material.consultationPlan?.consultantProfile?.userId ||
      material.subscriptionPlan?.consultantProfile?.userId ||
      material.webinarPlan?.consultantProfile?.userId ||
      material.classPlan?.consultantProfile?.userId;

    if (!isDevelopment() && ownerUserId !== session.user.id) {
      return NextResponse.json(
        {
          error: "Access denied",
          message: "You don't have permission to update this material",
          code: "FORBIDDEN",
        },
        { status: 403 },
      );
    }

    const body = await request.json();
    const { order, description } = body;

    const updateData: Record<string, unknown> = {};
    if (typeof order === "number") {
      updateData.order = order;
    }
    if (typeof description === "string") {
      updateData.description = description || null;
    }

    const updatedMaterial = await prisma.planMaterial.update({
      where: { id: materialId },
      data: updateData,
    });

    return NextResponse.json({ data: updatedMaterial });
  } catch (error) {
    console.error("Error updating material:", error);
    return NextResponse.json(
      {
        error: "Server error",
        message: "Failed to update material",
        code: "SERVER_ERROR",
      },
      { status: 500 },
    );
  }
}
