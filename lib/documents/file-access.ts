import "server-only";

import prisma from "@/lib/prisma";
import { hasAnyOrgPermission } from "@/lib/auth/org-permissions";
import { materialReaderWhere } from "@/lib/plans/material-access";
import { resolveDocumentParty } from "./document-party";
import { createSignedStorageUrl } from "./storage-verify";
import { isPreviewableMimeType } from "./urls";
import type { FileErrorCode } from "./file-errors";

export interface AuthorizedFile {
  storagePath: string;
  originalName: string;
  mimeType: string;
  previewable: boolean;
  viewerIsUploader: boolean;
  viewerRole: "consultee" | "consultant";
  /** The booking this file belongs to; null for plan materials. */
  appointmentId: string | null;
}

export type FileAccessOutcome =
  | { ok: true; file: AuthorizedFile }
  | {
      ok: false;
      code: Extract<FileErrorCode, "NOT_FOUND" | "STORAGE_MISSING">;
      viewerIsUploader: boolean;
      appointmentId: string | null;
    };

/**
 * One booking document for a party to it. Cancelled bookings stay readable
 * until retention tombstones their documents; removed rows read as not found.
 */
export async function authorizeAppointmentDocument(
  userId: string,
  documentId: string,
  appointmentId?: string,
): Promise<FileAccessOutcome> {
  const document = await prisma.appointmentDocument.findFirst({
    where: {
      id: documentId,
      deletedAt: null,
      ...(appointmentId ? { appointmentId } : {}),
    },
    select: {
      appointmentId: true,
      storagePath: true,
      originalName: true,
      mimeType: true,
      isStorageMissing: true,
      uploadedByRole: true,
    },
  });
  const party = document
    ? await resolveDocumentParty(prisma, document.appointmentId, userId)
    : null;
  if (!document || !party) {
    return {
      ok: false,
      code: "NOT_FOUND",
      viewerIsUploader: false,
      appointmentId: null,
    };
  }

  const viewerIsUploader =
    (document.uploadedByRole === "CONSULTANT") === (party.role === "expert");
  if (document.isStorageMissing) {
    return {
      ok: false,
      code: "STORAGE_MISSING",
      viewerIsUploader,
      appointmentId: document.appointmentId,
    };
  }
  return {
    ok: true,
    file: {
      storagePath: document.storagePath,
      originalName: document.originalName,
      mimeType: document.mimeType,
      previewable: isPreviewableMimeType(
        document.mimeType,
        document.originalName,
      ),
      viewerIsUploader,
      viewerRole: party.role === "expert" ? "consultant" : "consultee",
      appointmentId: document.appointmentId,
    },
  };
}

const planOwnerSelect = {
  organizationId: true,
  consultantProfile: { select: { userId: true } },
} as const;

const materialFileSelect = {
  storagePath: true,
  originalName: true,
  mimeType: true,
  organizationId: true,
  consultationPlan: { select: planOwnerSelect },
  subscriptionPlan: { select: planOwnerSelect },
  webinarPlan: { select: planOwnerSelect },
  classPlan: { select: planOwnerSelect },
} as const;

type MaterialFileRow = {
  organizationId: string | null;
  consultationPlan: { organizationId: string | null } | null;
  subscriptionPlan: { organizationId: string | null } | null;
  webinarPlan: { organizationId: string | null } | null;
  classPlan: { organizationId: string | null } | null;
};

function materialOrganizationId(row: MaterialFileRow): string | null {
  return (
    row.organizationId ??
    row.consultationPlan?.organizationId ??
    row.subscriptionPlan?.organizationId ??
    row.webinarPlan?.organizationId ??
    row.classPlan?.organizationId ??
    null
  );
}

/** Org operators who manage an org plan's materials may open them; other org roles see metadata only. */
async function managesOrgMaterials(
  organizationId: string | null,
  userId: string,
): Promise<boolean> {
  if (!organizationId) return false;
  const membership = await prisma.membership.findFirst({
    where: { organizationId, userId, status: "ACTIVE" },
    select: { role: true },
  });
  return (
    !!membership &&
    hasAnyOrgPermission(membership.role, ["materials.manage.orgPlan"])
  );
}

/** One plan material for its owner, co-hosts, paid learners or org material managers. */
export async function authorizePlanMaterial(
  userId: string,
  materialId: string,
): Promise<FileAccessOutcome> {
  const readable = await prisma.planMaterial.findFirst({
    where: { id: materialId, ...materialReaderWhere(userId) },
    select: materialFileSelect,
  });
  const material =
    readable ??
    (await prisma.planMaterial
      .findUnique({ where: { id: materialId }, select: materialFileSelect })
      .then(async (row) =>
        row && (await managesOrgMaterials(materialOrganizationId(row), userId))
          ? row
          : null,
      ));
  if (!material) {
    return {
      ok: false,
      code: "NOT_FOUND",
      viewerIsUploader: false,
      appointmentId: null,
    };
  }
  const ownerUserId =
    material.consultationPlan?.consultantProfile.userId ??
    material.subscriptionPlan?.consultantProfile.userId ??
    material.webinarPlan?.consultantProfile?.userId ??
    material.classPlan?.consultantProfile?.userId;
  const viewerIsUploader = ownerUserId === userId;
  return {
    ok: true,
    file: {
      storagePath: material.storagePath,
      originalName: material.originalName,
      mimeType: material.mimeType,
      previewable: isPreviewableMimeType(
        material.mimeType,
        material.originalName,
      ),
      viewerIsUploader,
      viewerRole: viewerIsUploader ? "consultant" : "consultee",
      appointmentId: null,
    },
  };
}

/** Signs an authorised file; non-previewable files are always served as attachments. */
export function signAuthorizedFile(
  file: AuthorizedFile,
  disposition: "inline" | "attachment",
  expiresInSeconds: number,
) {
  return createSignedStorageUrl({
    bucket: "documents",
    storagePath: file.storagePath,
    originalName: file.originalName,
    disposition:
      disposition === "inline" && file.previewable ? "inline" : "attachment",
    expiresInSeconds,
  });
}
