import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { reportSentryError } from "@/lib/observability/report";
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
    "consultationPlan" | "subscriptionPlan" | "webinarPlan" | "classPlan";
}

// Development mode check
const isDevelopment = () =>
  process.env.NODE_ENV === "development" &&
  process.env.DEV_BYPASS_AUTH === "true";

/**
 * Audit metadata when an organization operator manages a plan's materials.
 * Null when the plan's own consultant manages materials directly.
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
 * Grants access to either the owning consultant or an organization operator
 * holding `materials.manage.orgPlan` over an org-owned plan.
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
 * Records an organization operator's material change against the owning
 * consultant's membership so the consultant's dashboard surfaces `orgChanges`.
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

/** One org change to a plan material, as the plan's consultant sees it. */
export interface OrgMaterialChange {
  action: "added" | "updated" | "removed";
  materialId: string | null;
  fileName: string | null;
  orgName: string;
  actorName: string | null;
  at: Date;
}

const CHANGE_KIND: Record<string, OrgMaterialChange["action"]> = {
  [AUDIT_ACTIONS.CATALOG.PLAN_MATERIAL_ADDED]: "added",
  [AUDIT_ACTIONS.CATALOG.PLAN_MATERIAL_UPDATED]: "updated",
  [AUDIT_ACTIONS.CATALOG.PLAN_MATERIAL_REMOVED]: "removed",
};

function detailString(details: unknown, key: string): string | null {
  if (!details || typeof details !== "object") return null;
  const value = (details as Record<string, unknown>)[key];
  return typeof value === "string" ? value : null;
}

/** Recent organization-operated changes to this plan's materials. */
async function orgChangesForPlan(
  organizationId: string,
  planId: string,
): Promise<OrgMaterialChange[]> {
  const rows = await prisma.orgAuditLog.findMany({
    where: {
      organizationId,
      category: "CATALOG",
      action: { in: MATERIAL_AUDIT_ACTIONS },
      details: { path: ["planId"], equals: planId },
    },
    orderBy: { createdAt: "desc" },
    take: 20,
    select: {
      action: true,
      createdAt: true,
      details: true,
      actorMembershipId: true,
      organization: { select: { name: true } },
    },
  });
  if (rows.length === 0) return [];

  const actorIds = [
    ...new Set(
      rows
        .map((r) => r.actorMembershipId)
        .filter((id): id is string => id !== null),
    ),
  ];
  const actors = await prisma.membership.findMany({
    where: { id: { in: actorIds } },
    select: { id: true, user: { select: { name: true } } },
  });
  const actorName = new Map(actors.map((a) => [a.id, a.user.name]));

  return rows.map((r) => ({
    action: CHANGE_KIND[r.action] ?? "updated",
    materialId: detailString(r.details, "materialId"),
    fileName: detailString(r.details, "fileName"),
    orgName: r.organization.name,
    actorName: r.actorMembershipId
      ? (actorName.get(r.actorMembershipId) ?? null)
      : null,
    at: r.createdAt,
  }));
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

    const whereClause: Prisma.PlanMaterialWhereInput = {
      [config.planIdField]: planId,
    };

    const materials = await prisma.planMaterial.findMany({
      where: whereClause,
      orderBy: { order: "asc" },
    });

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

const MAX_MATERIALS_PER_PLAN = 25;

interface ResolvedMaterialUpload {
  fileName: string;
  originalName: string;
  fileSize: number;
  mimeType: string;
  fileUrl: string;
  storagePath: string;
  description: string | null;
}

const MaterialDirectCommitSchema = z.object({
  storagePath: z.string().trim().min(1),
  originalName: z.string().trim().min(1).max(255),
  mimeType: z.string().trim().min(1).max(120),
  fileSize: z.number().int().positive().optional(),
  description: z.string().max(2000).nullish(),
});

async function resolveMaterialUploadPayload(
  request: NextRequest,
  planId: string,
  config: PlanMaterialsConfig,
): Promise<
  | { ok: true; data: ResolvedMaterialUpload }
  | { ok: false; response: NextResponse }
> {
  const contentType = request.headers.get("content-type") ?? "";

  if (contentType.includes("application/json")) {
    const parsedBody = MaterialDirectCommitSchema.safeParse(
      await request.json().catch(() => null),
    );
    if (!parsedBody.success) {
      return {
        ok: false,
        response: NextResponse.json(
          {
            error: "Invalid upload metadata",
            message: "Please select a valid file to upload",
            code: "INVALID_INPUT",
          },
          { status: 400 },
        ),
      };
    }
    const jsonBody = parsedBody.data;

    const { verifyDirectUploadedObject } =
      await import("@/lib/documents/storage-verify");
    const verified = await verifyDirectUploadedObject({
      bucket: "documents",
      storagePath: jsonBody.storagePath,
      requiredPrefix: `plans/${config.planType}-plans/${planId}/`,
      claimedMimeType: jsonBody.mimeType,
    });
    if (!verified.ok) {
      return {
        ok: false,
        response: NextResponse.json(
          {
            error: "Upload validation failed",
            message: verified.message,
            code: verified.code,
          },
          { status: verified.code === "STORAGE_CONFIG_ERROR" ? 500 : 400 },
        ),
      };
    }

    return {
      ok: true,
      data: {
        fileName: verified.fileName,
        originalName: jsonBody.originalName,
        fileSize: verified.fileSize,
        mimeType: verified.mimeType,
        fileUrl: verified.fileUrl,
        storagePath: jsonBody.storagePath,
        description: jsonBody.description?.trim() || null,
      },
    };
  }

  const formData = await request.formData();
  const rawFile = formData.get("file");
  const file = rawFile instanceof File ? rawFile : null;
  const rawDesc = formData.get("description");
  const description =
    typeof rawDesc === "string" && rawDesc.trim() ? rawDesc.trim() : null;

  if (!file) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          error: "No file provided",
          message: "Please select a file to upload",
          code: "INVALID_INPUT",
        },
        { status: 400 },
      ),
    };
  }

  const uploadResult = await uploadPlanMaterial({
    planType: config.planType,
    planId,
    file,
    description: description || undefined,
  });

  if (!uploadResult.success) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          error: "Upload failed",
          message: uploadResult.error || "Failed to upload file",
          code: "UPLOAD_ERROR",
        },
        { status: 500 },
      ),
    };
  }

  return {
    ok: true,
    data: {
      fileName: uploadResult.fileName!,
      originalName: file.name,
      fileSize: uploadResult.fileSize!,
      mimeType: uploadResult.mimeType!,
      fileUrl: uploadResult.fileUrl!,
      storagePath: uploadResult.storagePath!,
      description,
    },
  };
}

async function lockPlanRowForUpdate(
  tx: Tx,
  planModel: PlanMaterialsConfig["planModel"],
  planId: string,
): Promise<void> {
  if (planModel === "consultationPlan") {
    await tx.$executeRaw`SELECT 1 FROM "ConsultationPlan" WHERE id = ${planId} FOR UPDATE`;
  } else if (planModel === "subscriptionPlan") {
    await tx.$executeRaw`SELECT 1 FROM "SubscriptionPlan" WHERE id = ${planId} FOR UPDATE`;
  } else if (planModel === "webinarPlan") {
    await tx.$executeRaw`SELECT 1 FROM "WebinarPlan" WHERE id = ${planId} FOR UPDATE`;
  } else {
    await tx.$executeRaw`SELECT 1 FROM "ClassPlan" WHERE id = ${planId} FOR UPDATE`;
  }
}

function persistPlanMaterialRecord(args: {
  planId: string;
  config: PlanMaterialsConfig;
  resolvedUpload: ResolvedMaterialUpload;
  organizationId: string | null;
  orgActor: OrgMaterialActor | null;
}) {
  const { planId, config, resolvedUpload, organizationId, orgActor } = args;
  const whereClause: Prisma.PlanMaterialWhereInput = {
    [config.planIdField]: planId,
  };

  return prisma.$transaction(async (tx) => {
    await lockPlanRowForUpdate(tx, config.planModel, planId);

    const existingCount = await tx.planMaterial.count({
      where: whereClause,
    });
    if (existingCount >= MAX_MATERIALS_PER_PLAN) {
      throw new Error("MATERIAL_LIMIT_REACHED");
    }

    const maxOrderResult = await tx.planMaterial.aggregate({
      where: whereClause,
      _max: { order: true },
    });
    const nextOrder = (maxOrderResult._max.order ?? -1) + 1;

    const created = await tx.planMaterial.create({
      data: {
        fileName: resolvedUpload.fileName,
        originalName: resolvedUpload.originalName,
        fileSize: resolvedUpload.fileSize,
        mimeType: resolvedUpload.mimeType,
        fileUrl: resolvedUpload.fileUrl,
        storagePath: resolvedUpload.storagePath,
        description: resolvedUpload.description,
        order: nextOrder,
        organizationId,
        [config.planIdField]: planId,
      } as Prisma.PlanMaterialUncheckedCreateInput,
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

    const uploadPayload = await resolveMaterialUploadPayload(
      request,
      planId,
      config,
    );
    if (!uploadPayload.ok) {
      return uploadPayload.response;
    }

    let material;
    try {
      material = await persistPlanMaterialRecord({
        planId,
        config,
        resolvedUpload: uploadPayload.data,
        organizationId: access.organizationId,
        orgActor: access.orgActor,
      });
    } catch (txError) {
      await deletePlanMaterial(uploadPayload.data.storagePath).catch(
        () => false,
      );
      if (
        txError instanceof Error &&
        txError.message === "MATERIAL_LIMIT_REACHED"
      ) {
        return NextResponse.json(
          {
            error: "Material limit reached",
            message: `A plan can have at most ${MAX_MATERIALS_PER_PLAN} materials.`,
            code: "MATERIAL_LIMIT_REACHED",
          },
          { status: 400 },
        );
      }
      throw txError;
    }

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
    // The row is already gone; the orphan sweep removes the leftover object.
    if (!storageDeleted) {
      reportSentryError(new Error("Plan material storage delete failed"), {
        subsystem: "storage",
        op: "plan-material-delete",
        extra: { materialId },
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
