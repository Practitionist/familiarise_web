import { NextRequest, NextResponse } from "next/server";
import prisma, { type Tx } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { getSession } from "@/lib/auth-server";
import { requireOrgAccess } from "@/lib/auth-helpers";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";
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
 * The org operator acting on an ORG-owned plan's materials, with what the
 * audit row needs (#1851 decision 8). Null when the caller is the plan's own
 * consultant (or the dev bypass), whose changes are their own business.
 */
interface OrgMaterialActor {
  organizationId: string;
  membershipId: string;
  consultantProfileId: string;
  planType: PlanType;
  planId: string;
}

type MaterialAccess =
  | { allowed: false; error: string }
  | {
      allowed: true;
      organizationId: string | null;
      orgActor: OrgMaterialActor | null;
    };

interface MaterialPlan {
  id: string;
  consultantProfile: { id: string; userId: string } | null;
  organizationId: string | null;
}

/**
 * Who may manage a plan's materials. Two paths:
 *   1. the owning consultant (personal and org plans alike), or
 *   2. an org member holding `materials.manage.orgPlan` over the plan's
 *      organization — ORG-owned plans only (#1851 decision 8). A personal plan
 *      has no organizationId, so no org key can ever reach it.
 */
async function resolvePlanAccess(
  userId: string,
  plan: MaterialPlan | null,
  planType: PlanType,
): Promise<MaterialAccess> {
  if (plan && isDevelopment()) {
    return {
      allowed: true,
      organizationId: plan.organizationId,
      orgActor: null,
    };
  }
  if (!plan?.consultantProfile) {
    return { allowed: false, error: "Plan not found" };
  }
  if (plan.consultantProfile.userId === userId) {
    return {
      allowed: true,
      organizationId: plan.organizationId,
      orgActor: null,
    };
  }
  if (plan.organizationId) {
    const access = await requireOrgAccess(plan.organizationId, {
      permission: "materials.manage.orgPlan",
    });
    if (!access.error) {
      return {
        allowed: true,
        organizationId: plan.organizationId,
        orgActor: {
          organizationId: plan.organizationId,
          membershipId: access.member.id,
          consultantProfileId: plan.consultantProfile.id,
          planType,
          planId: plan.id,
        },
      };
    }
  }
  return {
    allowed: false,
    error: "You don't have permission to manage this plan's materials",
  };
}

const PLAN_SELECT = {
  id: true,
  consultantProfile: { select: { id: true, userId: true } },
  organizationId: true,
} as const;

/**
 * Verify the user may manage this plan's materials. Returns the plan's
 * organizationId so uploads can mirror the denormalized
 * `PlanMaterial.organizationId` tag.
 */
async function verifyMaterialManageAccess(
  userId: string,
  planId: string,
  config: PlanMaterialsConfig,
): Promise<MaterialAccess> {
  if (isDevelopment()) {
    return { allowed: true, organizationId: null, orgActor: null };
  }

  try {
    let plan: MaterialPlan | null = null;
    switch (config.planModel) {
      case "consultationPlan":
        plan = await prisma.consultationPlan.findFirst({
          where: { id: planId },
          select: PLAN_SELECT,
        });
        break;
      case "subscriptionPlan":
        plan = await prisma.subscriptionPlan.findFirst({
          where: { id: planId },
          select: PLAN_SELECT,
        });
        break;
      case "webinarPlan":
        plan = await prisma.webinarPlan.findFirst({
          where: { id: planId },
          select: PLAN_SELECT,
        });
        break;
      case "classPlan":
        plan = await prisma.classPlan.findFirst({
          where: { id: planId },
          select: PLAN_SELECT,
        });
        break;
    }
    return await resolvePlanAccess(userId, plan, config.planType);
  } catch (error) {
    console.error("Error verifying material access:", error);
    return { allowed: false, error: "Failed to verify access" };
  }
}

/** Row-level variant for delete/update: resolves via the material's plan FKs. */
async function resolveMaterialRowAccess(
  userId: string,
  materialId: string,
): Promise<
  | { status: "not_found" }
  | { status: "denied" }
  | {
      status: "allowed";
      storagePath: string;
      fileName: string;
      orgActor: OrgMaterialActor | null;
    }
> {
  const material = await prisma.planMaterial.findUnique({
    where: { id: materialId },
    select: {
      storagePath: true,
      originalName: true,
      consultationPlan: { select: PLAN_SELECT },
      subscriptionPlan: { select: PLAN_SELECT },
      webinarPlan: { select: PLAN_SELECT },
      classPlan: { select: PLAN_SELECT },
    },
  });
  if (!material) return { status: "not_found" };

  const candidates: Array<[PlanType, MaterialPlan | null]> = [
    ["consultation", material.consultationPlan],
    ["subscription", material.subscriptionPlan],
    ["webinar", material.webinarPlan],
    ["class", material.classPlan],
  ];
  const [planType, plan] = candidates.find(([, p]) => p !== null) ?? [
    "class",
    null,
  ];
  if (!plan) return { status: "not_found" };

  const access = await resolvePlanAccess(userId, plan, planType);
  if (!access.allowed) return { status: "denied" };
  return {
    status: "allowed",
    storagePath: material.storagePath,
    fileName: material.originalName,
    orgActor: access.orgActor,
  };
}

const MATERIAL_AUDIT_ACTIONS = [
  AUDIT_ACTIONS.CATALOG.PLAN_MATERIAL_ADDED,
  AUDIT_ACTIONS.CATALOG.PLAN_MATERIAL_UPDATED,
  AUDIT_ACTIONS.CATALOG.PLAN_MATERIAL_REMOVED,
];

/**
 * #1851 decision 8 — an org change to an expert's material is audited, and
 * the row targets the delivering expert's membership so it is theirs to see
 * (the plan owner's materials GET returns it as `orgChanges`).
 */
async function auditOrgMaterialChange(
  tx: Pick<Tx, "orgAuditLog" | "membership">,
  actor: OrgMaterialActor,
  change: {
    action: (typeof MATERIAL_AUDIT_ACTIONS)[number];
    materialId: string;
    fileName: string;
  },
): Promise<void> {
  const expert = await tx.membership.findFirst({
    where: {
      organizationId: actor.organizationId,
      consultantProfileId: actor.consultantProfileId,
    },
    select: { id: true },
  });
  await tx.orgAuditLog.create({
    data: {
      organizationId: actor.organizationId,
      actorMembershipId: actor.membershipId,
      targetMembershipId: expert?.id ?? null,
      category: "CATALOG",
      action: change.action,
      description: `Plan material ${change.fileName}: ${change.action}`,
      details: {
        planType: actor.planType,
        planId: actor.planId,
        materialId: change.materialId,
        fileName: change.fileName,
      },
    },
  });
}

/** The org's recent changes to this plan's materials, for its consultant. */
async function orgChangesForPlan(organizationId: string, planId: string) {
  return prisma.orgAuditLog.findMany({
    where: {
      organizationId,
      category: "CATALOG",
      action: { in: MATERIAL_AUDIT_ACTIONS },
      details: { path: ["planId"], equals: planId },
    },
    orderBy: { createdAt: "desc" },
    take: 20,
    select: { action: true, createdAt: true, details: true },
  });
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
    const session = await getSession(true);
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

    // Verify manage access (owner consultant or materials.manage.orgPlan)
    const access = await verifyMaterialManageAccess(
      session.user.id,
      planId,
      config,
    );
    if (!access.allowed) {
      return NextResponse.json(
        {
          error: "Access denied",
          message:
            access.error || "You don't have permission to view these materials",
          code: "FORBIDDEN",
        },
        { status: 403 },
      );
    }

    // Fetch materials
    const whereClause: Prisma.PlanMaterialWhereInput = {
      [config.planIdField]: planId,
    };

    const materials = await prisma.planMaterial.findMany({
      where: whereClause,
      orderBy: { order: "asc" },
    });

    // #1851 decision 8 — the plan's own consultant sees what the org changed.
    const orgChanges =
      access.orgActor === null && access.organizationId
        ? await orgChangesForPlan(access.organizationId, planId)
        : undefined;

    return NextResponse.json({ data: materials, orgChanges });
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
    const session = await getSession(true);
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

    // Verify manage access (owner consultant or materials.manage.orgPlan)
    const access = await verifyMaterialManageAccess(
      session.user.id,
      planId,
      config,
    );
    if (!access.allowed) {
      return NextResponse.json(
        {
          error: "Access denied",
          message:
            access.error ||
            "You don't have permission to upload materials to this plan",
          code: "FORBIDDEN",
        },
        { status: 403 },
      );
    }
    const { organizationId, orgActor } = access;

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
    const whereClause: Prisma.PlanMaterialWhereInput = {
      [config.planIdField]: planId,
    };

    const maxOrderResult = await prisma.planMaterial.aggregate({
      where: whereClause,
      _max: { order: true },
    });
    const nextOrder = (maxOrderResult._max.order ?? -1) + 1;

    // Create database record — mirror the plan's org tag so org dashboards
    // can scope materials without polymorphic joins.
    const createData = {
      fileName: uploadResult.fileName!,
      originalName: file.name,
      fileSize: uploadResult.fileSize!,
      mimeType: uploadResult.mimeType!,
      fileUrl: uploadResult.fileUrl!,
      storagePath: uploadResult.storagePath!,
      description: description || null,
      order: nextOrder,
      organizationId,
      [config.planIdField]: planId,
    };

    const material = await prisma.$transaction(async (tx) => {
      const created = await tx.planMaterial.create({
        data: createData as Prisma.PlanMaterialUncheckedCreateInput,
      });
      if (orgActor) {
        await auditOrgMaterialChange(tx, orgActor, {
          action: AUDIT_ACTIONS.CATALOG.PLAN_MATERIAL_ADDED,
          materialId: created.id,
          fileName: created.originalName,
        });
      }
      return created;
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
    const session = await getSession(true);
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

    // Find the material and verify manage access (owner or materials.manage.orgPlan)
    const access = await resolveMaterialRowAccess(session.user.id, materialId);
    if (access.status === "not_found") {
      return NextResponse.json(
        {
          error: "Material not found",
          message: "The requested material does not exist",
          code: "NOT_FOUND",
        },
        { status: 404 },
      );
    }
    if (access.status === "denied") {
      return NextResponse.json(
        {
          error: "Access denied",
          message: "You don't have permission to delete this material",
          code: "FORBIDDEN",
        },
        { status: 403 },
      );
    }

    // Row and audit first, storage after: a failed storage delete leaves an
    // orphaned object rather than a row pointing at a file that is gone, or a
    // removal the org's audit trail never recorded (#1851 decision 8).
    const { orgActor, fileName } = access;
    await prisma.$transaction(async (tx) => {
      await tx.planMaterial.delete({ where: { id: materialId } });
      if (orgActor) {
        await auditOrgMaterialChange(tx, orgActor, {
          action: AUDIT_ACTIONS.CATALOG.PLAN_MATERIAL_REMOVED,
          materialId,
          fileName,
        });
      }
    });

    const storageDeleted = await deletePlanMaterial(access.storagePath).catch(
      () => false,
    );
    if (!storageDeleted) {
      console.warn("Plan material storage delete failed", {
        materialId,
        storagePath: access.storagePath,
      });
    }

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
    const session = await getSession(true);
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

    // Find the material and verify manage access (owner or materials.manage.orgPlan)
    const access = await resolveMaterialRowAccess(session.user.id, materialId);
    if (access.status === "not_found") {
      return NextResponse.json(
        {
          error: "Material not found",
          message: "The requested material does not exist",
          code: "NOT_FOUND",
        },
        { status: 404 },
      );
    }
    if (access.status === "denied") {
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
    const { order, description } = body as {
      order?: number;
      description?: string;
    };

    const updateData: Prisma.PlanMaterialUpdateInput = {};
    if (typeof order === "number") {
      updateData.order = order;
    }
    if (typeof description === "string") {
      updateData.description = description || null;
    }

    const { orgActor, fileName } = access;
    const updatedMaterial = await prisma.$transaction(async (tx) => {
      const updated = await tx.planMaterial.update({
        where: { id: materialId },
        data: updateData,
      });
      if (orgActor) {
        await auditOrgMaterialChange(tx, orgActor, {
          action: AUDIT_ACTIONS.CATALOG.PLAN_MATERIAL_UPDATED,
          materialId,
          fileName,
        });
      }
      return updated;
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
