import { randomUUID } from "node:crypto";
import * as Sentry from "@sentry/nextjs";
import { NextResponse } from "next/server";
import { z } from "zod";
import { reportSentryError } from "@/lib/observability/report";
import prisma, { type Tx } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { getSession } from "@/lib/auth-server";
import { requireOrgAccess } from "@/lib/auth-helpers";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";
import { isActiveOrgExpert } from "@/lib/enterprise/membership-guards";
import {
  applyRateLimit,
  documentCommitLimiter,
  documentUploadLimiter,
} from "@/lib/rate-limit";
import { deletePlanMaterial, type PlanType } from "@/lib/supabase";
import {
  generateStorageFileName,
  supabaseAdmin,
} from "@/lib/supabase-storage-core";
import {
  FileRouteError,
  answerFileRoute,
  fileApiError,
  parseJsonBody,
} from "@/lib/documents/api-error";
import { validateUploadFile } from "@/lib/documents/file-policy";
import { verifyDirectUploadedObject } from "@/lib/documents/storage-verify";
import { getMaterialViewerUrl } from "@/lib/documents/urls";

// Type definitions
export interface PlanMaterialsConfig {
  planType: PlanType;
  planIdField: string;
  planModel:
    "consultationPlan" | "subscriptionPlan" | "webinarPlan" | "classPlan";
}

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
 * Grants access to either the owning consultant (on an org-owned plan, only
 * while an ACTIVE EXPERT member) or an organization operator holding
 * `materials.manage.orgPlan` over an org-owned plan.
 */
async function resolvePlanAccess(
  userId: string,
  plan: MaterialPlan | null,
  planType: PlanType,
): Promise<MaterialAccess> {
  if (!plan?.consultantProfile) {
    return { allowed: false, error: "Plan not found" };
  }
  if (
    plan.consultantProfile.userId === userId &&
    (!plan.organizationId ||
      (await isActiveOrgExpert(
        prisma,
        plan.organizationId,
        plan.consultantProfile.id,
      )))
  ) {
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
      planType: PlanType;
      planId: string;
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
    planType,
    planId: plan.id,
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
      description: `Plan material ${change.fileName} ${CHANGE_KIND[change.action]}`,
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

const MAX_MATERIALS_PER_PLAN = 25;

/** What list and mutation responses carry: never the storage path or a stored link. */
const MATERIAL_PUBLIC_SELECT = {
  id: true,
  originalName: true,
  fileSize: true,
  mimeType: true,
  description: true,
  order: true,
  uploadedAt: true,
  updatedAt: true,
} as const satisfies Prisma.PlanMaterialSelect;

const MaterialFileSchema = z.object({
  storagePath: z.string().trim().min(1),
  originalName: z.string().trim().min(1).max(200),
  mimeType: z.string().trim().max(120),
  fileSize: z.number().int().nonnegative(),
});

const MaterialCommitSchema = MaterialFileSchema.extend({
  description: z.string().trim().max(500).nullish(),
});

const MaterialUploadUrlSchema = MaterialFileSchema.omit({ storagePath: true });

const MaterialUpdateSchema = z
  .object({
    originalName: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(500).nullish(),
  })
  .refine((b) => b.originalName !== undefined || b.description !== undefined);

const MaterialOrderSchema = z.object({
  orderedIds: z
    .array(z.string().min(1))
    .min(1)
    .max(MAX_MATERIALS_PER_PLAN)
    .refine((ids) => new Set(ids).size === ids.length),
});

function materialFolder(planType: PlanType, planId: string): string {
  return `plans/${planType}-plans/${planId}`;
}

function policyMimeType(file: {
  originalName: string;
  mimeType: string;
  fileSize: number;
}): string {
  const policy = validateUploadFile({
    size: file.fileSize,
    type: file.mimeType,
    name: file.originalName,
  });
  if (!policy.ok) throw new FileRouteError(policy.code);
  return policy.mimeType;
}

async function verifyMaterialObject(
  planType: PlanType,
  planId: string,
  file: z.infer<typeof MaterialFileSchema>,
) {
  const verified = await verifyDirectUploadedObject({
    bucket: "documents",
    storagePath: file.storagePath,
    requiredPrefix: `${materialFolder(planType, planId)}/`,
    claimedMimeType: policyMimeType(file),
  });
  if (!verified.ok) throw new FileRouteError(verified.code);
  return verified;
}

async function requireSessionUser(): Promise<string> {
  const session = await getSession();
  if (!session?.user?.id) throw new FileRouteError("UNAUTHORIZED");
  return session.user.id;
}

async function requirePlanManager(
  userId: string,
  planId: string,
  config: PlanMaterialsConfig,
) {
  const access = await verifyMaterialManageAccess(userId, planId, config);
  if (!access.allowed) throw new FileRouteError("FORBIDDEN");
  return access;
}

async function requireMaterialManager(userId: string, materialId: string) {
  const access = await resolveMaterialRowAccess(userId, materialId);
  if (access.status === "not_found") throw new FileRouteError("NOT_FOUND");
  if (access.status === "denied") throw new FileRouteError("FORBIDDEN");
  return access;
}

/** GET: the plan's materials in display order, for people who manage them. */
export function handleGetMaterials(
  planId: string,
  config: PlanMaterialsConfig,
): Promise<Response> {
  return answerFileRoute(async () => {
    const userId = await requireSessionUser();
    const access = await requirePlanManager(userId, planId, config);
    const data = await prisma.planMaterial.findMany({
      where: { [config.planIdField]: planId },
      orderBy: [{ order: "asc" }, { uploadedAt: "asc" }],
      select: MATERIAL_PUBLIC_SELECT,
    });
    const orgChanges =
      access.orgActor === null && access.organizationId
        ? await orgChangesForPlan(access.organizationId, planId)
        : undefined;
    return NextResponse.json({ data, orgChanges });
  }, "plans");
}

/** POST upload-url: a single-use upload slot under the plan's folder. */
export function handleMaterialUploadUrl(
  request: Request,
  planId: string,
  config: PlanMaterialsConfig,
): Promise<Response> {
  return answerFileRoute(async () => {
    const userId = await requireSessionUser();
    const limited = await applyRateLimit(documentUploadLimiter, userId);
    if (limited) return limited;
    await requirePlanManager(userId, planId, config);
    const body = await parseJsonBody(request, MaterialUploadUrlSchema);
    const mimeType = policyMimeType(body);
    if (!supabaseAdmin) throw new FileRouteError("STORAGE_UNAVAILABLE");
    const storagePath = `${materialFolder(config.planType, planId)}/${generateStorageFileName(mimeType)}`;
    const { data, error } = await supabaseAdmin.storage
      .from("documents")
      .createSignedUploadUrl(storagePath, { upsert: false });
    if (error || !data?.signedUrl) {
      Sentry.captureException(error ?? new Error("No signed upload URL"), {
        tags: { subsystem: "storage" },
      });
      throw new FileRouteError("STORAGE_UNAVAILABLE");
    }
    return NextResponse.json(
      { uploadUrl: data.signedUrl, storagePath, mimeType },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  }, "plans");
}

/**
 * Deletes an object only when no row still points at it. Returns true when the
 * path is free (deleted now or unreferenced and already gone).
 */
async function discardUnreferencedMaterial(
  storagePath: string,
): Promise<boolean> {
  try {
    const referenced = await prisma.planMaterial.count({
      where: { storagePath },
    });
    if (referenced > 0) return false;
    return await deletePlanMaterial(storagePath).catch(() => false);
  } catch {
    // Best-effort: the orphan sweep owns anything left here.
    return false;
  }
}

/** Discards a refused commit's object: only under this plan's folder, never a referenced one. */
async function discardRefusedMaterial(
  planType: PlanType,
  planId: string,
  storagePath: string,
): Promise<void> {
  if (
    !storagePath.startsWith(`${materialFolder(planType, planId)}/`) ||
    storagePath.includes("..")
  )
    return;
  await discardUnreferencedMaterial(storagePath);
}

/** POST: commits an uploaded object as the plan's next material. */
export function handleUploadMaterial(
  request: Request,
  planId: string,
  config: PlanMaterialsConfig,
): Promise<Response> {
  return answerFileRoute(async () => {
    const userId = await requireSessionUser();
    const limited = await applyRateLimit(documentCommitLimiter, userId);
    // A rate-limited commit keeps its object: the client retries the same path.
    if (limited) return limited;
    const access = await requirePlanManager(userId, planId, config);
    const body = await parseJsonBody(request, MaterialCommitSchema);
    const whereClause: Prisma.PlanMaterialWhereInput = {
      [config.planIdField]: planId,
    };

    // A corrected retry may commit this same upload; preflight refusal preserves it.
    policyMimeType(body);
    // A lookup failure is ambiguous; keep the uploaded object for a retry.
    const committed = await prisma.planMaterial.findFirst({
      where: { ...whereClause, storagePath: body.storagePath },
      select: MATERIAL_PUBLIC_SELECT,
    });
    if (committed) return NextResponse.json({ data: committed });

    try {
      const stored = await verifyMaterialObject(config.planType, planId, body);
      const outcome = await prisma.$transaction(async (tx) => {
        await lockPlanRowForUpdate(tx, config.planModel, planId);
        // A replay of a commit whose response was lost returns the row the
        // first attempt wrote, instead of a duplicate or a deleted object.
        const replayed = await tx.planMaterial.findFirst({
          where: { ...whereClause, storagePath: body.storagePath },
          select: MATERIAL_PUBLIC_SELECT,
        });
        if (replayed) return { row: replayed, created: false };
        const existing = await tx.planMaterial.count({ where: whereClause });
        if (existing >= MAX_MATERIALS_PER_PLAN) {
          throw new FileRouteError("MATERIAL_LIMIT_REACHED");
        }
        const maxOrder = await tx.planMaterial.aggregate({
          where: whereClause,
          _max: { order: true },
        });
        const id = randomUUID();
        const row = await tx.planMaterial.create({
          data: {
            id,
            fileName: stored.fileName,
            originalName: body.originalName,
            fileSize: stored.fileSize,
            mimeType: stored.mimeType,
            fileUrl: getMaterialViewerUrl(id),
            storagePath: body.storagePath,
            description: body.description || null,
            order: (maxOrder._max.order ?? -1) + 1,
            organizationId: access.organizationId,
            [config.planIdField]: planId,
          } as Prisma.PlanMaterialUncheckedCreateInput,
          select: MATERIAL_PUBLIC_SELECT,
        });
        if (access.orgActor) {
          await auditOrgMaterialChange(tx, access.orgActor, {
            action: AUDIT_ACTIONS.CATALOG.PLAN_MATERIAL_ADDED,
            materialId: row.id,
            fileName: row.originalName,
          });
        }
        return { row, created: true };
      });
      return NextResponse.json(
        { data: outcome.row },
        { status: outcome.created ? 201 : 200 },
      );
    } catch (error) {
      // A storage timeout does not prove the object is bad; keep it for a retry.
      const storageUnavailable =
        error instanceof FileRouteError && error.code === "STORAGE_UNAVAILABLE";
      if (!storageUnavailable) {
        await discardRefusedMaterial(config.planType, planId, body.storagePath);
      }
      throw error;
    }
  }, "plans");
}

/** PUT order: one call that sets the whole plan's order; the ids must be exactly the plan's materials. */
export function handleReorderMaterials(
  request: Request,
  planId: string,
  config: PlanMaterialsConfig,
): Promise<Response> {
  return answerFileRoute(async () => {
    const userId = await requireSessionUser();
    const access = await requirePlanManager(userId, planId, config);
    const { orderedIds } = await parseJsonBody(request, MaterialOrderSchema);
    const whereClause: Prisma.PlanMaterialWhereInput = {
      [config.planIdField]: planId,
    };
    await prisma.$transaction(async (tx) => {
      await lockPlanRowForUpdate(tx, config.planModel, planId);
      const current = await tx.planMaterial.findMany({
        where: whereClause,
        select: { id: true },
      });
      const ids = new Set(current.map((m) => m.id));
      if (
        current.length !== orderedIds.length ||
        !orderedIds.every((id) => ids.has(id))
      ) {
        throw new FileRouteError("INVALID_INPUT");
      }
      for (const [order, id] of orderedIds.entries()) {
        await tx.planMaterial.updateMany({
          where: { id, ...whereClause },
          data: { order },
        });
      }
      if (access.orgActor) {
        await auditOrgMaterialChange(tx, access.orgActor, {
          action: AUDIT_ACTIONS.CATALOG.PLAN_MATERIAL_UPDATED,
          materialId: orderedIds[0]!,
          fileName: "Order of files",
        });
      }
    });
    return NextResponse.json({ data: { orderedIds } });
  }, "plans");
}

/** DELETE: row and audit first, then the object; the orphan sweep catches a failed object delete. */
export function handleDeleteMaterial(materialId: string): Promise<Response> {
  return answerFileRoute(async () => {
    const userId = await requireSessionUser();
    const access = await requireMaterialManager(userId, materialId);
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
      reportSentryError(new Error("Plan material storage delete failed"), {
        subsystem: "storage",
        op: "plan-material-delete",
        extra: { materialId },
      });
    }
    return NextResponse.json({ success: true });
  }, "plans");
}

/** PATCH: rename a material or edit its description. */
export function handleUpdateMaterial(
  request: Request,
  materialId: string,
): Promise<Response> {
  return answerFileRoute(async () => {
    const userId = await requireSessionUser();
    const access = await requireMaterialManager(userId, materialId);
    const body = await parseJsonBody(request, MaterialUpdateSchema);
    const updated = await prisma.$transaction(async (tx) => {
      const row = await tx.planMaterial.update({
        where: { id: materialId },
        data: {
          ...(body.originalName !== undefined && {
            originalName: body.originalName,
          }),
          ...(body.description !== undefined && {
            description: body.description || null,
          }),
        },
        select: MATERIAL_PUBLIC_SELECT,
      });
      if (access.orgActor) {
        await auditOrgMaterialChange(tx, access.orgActor, {
          action: AUDIT_ACTIONS.CATALOG.PLAN_MATERIAL_UPDATED,
          materialId,
          fileName: row.originalName,
        });
      }
      return row;
    });
    return NextResponse.json({ data: updated });
  }, "plans");
}

/**
 * PUT: replaces a material's file and keeps its name, description and order.
 * The swap is conditional on the old object, so of two overlapping replaces
 * one wins and the other gets 409 with its new object deleted.
 */
export function handleReplaceMaterial(
  request: Request,
  materialId: string,
): Promise<Response> {
  return answerFileRoute(async () => {
    const userId = await requireSessionUser();
    const access = await requireMaterialManager(userId, materialId);
    const body = await parseJsonBody(request, MaterialFileSchema);
    // A retry of a replace whose response was lost names the path the row now
    // holds. It is already the live object, so this is a no-op, not a swap.
    if (body.storagePath === access.storagePath) {
      const row = await prisma.planMaterial.findUniqueOrThrow({
        where: { id: materialId },
        select: MATERIAL_PUBLIC_SELECT,
      });
      return NextResponse.json({ data: row });
    }
    const stored = await verifyMaterialObject(
      access.planType,
      access.planId,
      body,
    );
    const swapped = await prisma.$transaction(async (tx) => {
      const result = await tx.planMaterial.updateMany({
        where: { id: materialId, storagePath: access.storagePath },
        data: {
          storagePath: body.storagePath,
          fileName: stored.fileName,
          fileSize: stored.fileSize,
          mimeType: stored.mimeType,
        },
      });
      if (result.count === 1 && access.orgActor) {
        await auditOrgMaterialChange(tx, access.orgActor, {
          action: AUDIT_ACTIONS.CATALOG.PLAN_MATERIAL_UPDATED,
          materialId,
          fileName: access.fileName,
        });
      }
      return result.count === 1;
    });
    if (!swapped) {
      await discardUnreferencedMaterial(body.storagePath);
      return fileApiError("SUPERSEDED");
    }
    const oldDeleted = await discardUnreferencedMaterial(access.storagePath);
    if (!oldDeleted) {
      reportSentryError(
        new Error("Replaced plan material object not deleted"),
        {
          subsystem: "storage",
          op: "plan-material-replace",
          extra: { materialId },
        },
      );
    }
    const row = await prisma.planMaterial.findUniqueOrThrow({
      where: { id: materialId },
      select: MATERIAL_PUBLIC_SELECT,
    });
    return NextResponse.json({ data: row });
  }, "plans");
}
