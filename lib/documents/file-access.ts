import "server-only";

import type { ParticipantStatus, Prisma } from "@prisma/client";

import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";
import { isBookingTerminal } from "@/lib/appointments/terminal-status";
import { isPreviewableMimeType } from "@/lib/documents/urls";
import { createSignedStorageUrl } from "@/lib/documents/storage-verify";
import type { FileErrorCode } from "@/lib/documents/file-errors";

export interface AuthorizedFile {
  storagePath: string;
  originalName: string;
  mimeType: string;
  previewable: boolean;
  viewerIsUploader: boolean;
  /** The booking this file belongs to; null for plan materials. */
  appointmentId: string | null;
}

export type FileAccessOutcome =
  | { ok: true; file: AuthorizedFile }
  | {
      ok: false;
      code: Extract<
        FileErrorCode,
        "FORBIDDEN" | "NOT_FOUND" | "APPOINTMENT_TERMINAL" | "STORAGE_MISSING"
      >;
      viewerIsUploader: boolean;
    };

export const FILE_ACCESS_STATUS: Record<
  Exclude<FileAccessOutcome, { ok: true }>["code"],
  number
> = {
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  APPOINTMENT_TERMINAL: 403,
  STORAGE_MISSING: 404,
};

function isDevBypass(): boolean {
  return (
    process.env.NODE_ENV === "development" &&
    process.env.DEV_BYPASS_AUTH === "true"
  );
}

const LIVE_SEAT_STATUSES: ParticipantStatus[] = ["CONFIRMED", "ATTENDED"];

function documentPartyWhere(userId: string): Prisma.AppointmentWhereInput {
  const ownsPlan = { consultantProfile: { user: { id: userId } } };
  const holdsSeat = {
    appointment: {
      participants: { some: { userId, status: { in: LIVE_SEAT_STATUSES } } },
    },
  };
  return {
    OR: [
      { consultation: { requestedBy: { user: { id: userId } } } },
      { consultation: { consultationPlan: ownsPlan } },
      {
        subscription: {
          OR: [
            { requestedBy: { user: { id: userId } } },
            { subscriptionPlan: ownsPlan },
          ],
        },
      },
      { webinar: { OR: [{ webinarPlan: ownsPlan }, holdsSeat] } },
      { class: { OR: [{ classPlan: ownsPlan }, holdsSeat] } },
    ],
  };
}

const planOwnerSelect = {
  select: { consultantProfile: { select: { userId: true } } },
} as const;

/** Authorises one appointment document for a party to its booking. */
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
  if (!document) {
    return { ok: false, code: "NOT_FOUND", viewerIsUploader: false };
  }

  const appointment = await prisma.appointment.findFirst({
    where: {
      id: document.appointmentId,
      ...(isDevBypass() ? {} : documentPartyWhere(userId)),
    },
    select: {
      consultation: {
        select: { status: true, consultationPlan: planOwnerSelect },
      },
      subscription: {
        select: { status: true, subscriptionPlan: planOwnerSelect },
      },
      webinar: { select: { status: true, webinarPlan: planOwnerSelect } },
      class: { select: { status: true, classPlan: planOwnerSelect } },
    },
  });
  if (!appointment) {
    return { ok: false, code: "NOT_FOUND", viewerIsUploader: false };
  }

  const expertUserId =
    appointment.consultation?.consultationPlan.consultantProfile.userId ??
    appointment.subscription?.subscriptionPlan.consultantProfile.userId ??
    appointment.webinar?.webinarPlan.consultantProfile?.userId ??
    appointment.class?.classPlan.consultantProfile?.userId ??
    null;
  const viewerIsExpert = expertUserId === userId;
  const viewerIsUploader =
    (document.uploadedByRole === "CONSULTANT") === viewerIsExpert;

  if (isBookingTerminal(appointment)) {
    return { ok: false, code: "APPOINTMENT_TERMINAL", viewerIsUploader };
  }
  if (document.isStorageMissing) {
    return { ok: false, code: "STORAGE_MISSING", viewerIsUploader };
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
      appointmentId: document.appointmentId,
    },
  };
}

const CLOSED_OR_UNPAID_BOOKING_STATUSES = [
  "CANCELLED",
  "REJECTED",
  "EXPIRED",
  "PENDING",
] as const;

const ACCEPTED_COLLABORATOR = (userId: string) => ({
  where: { status: "ACCEPTED" as const, consultantProfile: { userId } },
  select: { id: true },
  take: 1,
});

function fetchMaterialWithAccessContext(materialId: string, userId: string) {
  const seated = {
    status: { not: "CANCELLED" as const },
    appointment: {
      participants: { some: { userId, status: { in: LIVE_SEAT_STATUSES } } },
    },
  };
  const ownedPlan = {
    id: true,
    organizationId: true,
    consultantProfile: { select: { userId: true } },
  } as const;
  return prisma.planMaterial.findUnique({
    where: { id: materialId },
    include: {
      consultationPlan: {
        select: {
          ...ownedPlan,
          consultations: {
            where: {
              requestedBy: { user: { id: userId } },
              status: { notIn: [...CLOSED_OR_UNPAID_BOOKING_STATUSES] },
            },
            select: { id: true },
            take: 1,
          },
        },
      },
      subscriptionPlan: {
        select: {
          ...ownedPlan,
          subscriptions: {
            where: {
              requestedBy: { user: { id: userId } },
              status: { notIn: [...CLOSED_OR_UNPAID_BOOKING_STATUSES] },
            },
            select: { id: true },
            take: 1,
          },
        },
      },
      webinarPlan: {
        select: {
          ...ownedPlan,
          collaborators: ACCEPTED_COLLABORATOR(userId),
          webinars: { where: seated, select: { id: true }, take: 1 },
        },
      },
      classPlan: {
        select: {
          ...ownedPlan,
          collaborators: ACCEPTED_COLLABORATOR(userId),
          classes: { where: seated, select: { id: true }, take: 1 },
        },
      },
    },
  });
}

/** Authorises one plan material for its owner, collaborators, paid learners or org staff. */
export async function authorizePlanMaterial(
  userId: string,
  materialId: string,
): Promise<FileAccessOutcome> {
  const material = await fetchMaterialWithAccessContext(materialId, userId);
  if (!material) {
    return { ok: false, code: "NOT_FOUND", viewerIsUploader: false };
  }

  const ownerUserId =
    material.consultationPlan?.consultantProfile?.userId ??
    material.subscriptionPlan?.consultantProfile?.userId ??
    material.webinarPlan?.consultantProfile?.userId ??
    material.classPlan?.consultantProfile?.userId;
  const viewerIsUploader = ownerUserId === userId;

  const allowed =
    isDevBypass() ||
    viewerIsUploader ||
    Boolean(material.webinarPlan?.collaborators.length) ||
    Boolean(material.classPlan?.collaborators.length) ||
    Boolean(material.consultationPlan?.consultations.length) ||
    Boolean(material.subscriptionPlan?.subscriptions.length) ||
    Boolean(material.webinarPlan?.webinars.length) ||
    Boolean(material.classPlan?.classes.length) ||
    (await hasOrgMaterialAccess(material));
  if (!allowed) {
    return { ok: false, code: "FORBIDDEN", viewerIsUploader };
  }

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
      appointmentId: null,
    },
  };
}

async function hasOrgMaterialAccess(
  material: NonNullable<
    Awaited<ReturnType<typeof fetchMaterialWithAccessContext>>
  >,
): Promise<boolean> {
  const planOrganizationId =
    material.organizationId ??
    material.consultationPlan?.organizationId ??
    material.subscriptionPlan?.organizationId ??
    material.webinarPlan?.organizationId ??
    material.classPlan?.organizationId ??
    null;
  if (!planOrganizationId) return false;
  const [catalogAccess, opsAccess] = await Promise.all([
    requireOrgAccess(planOrganizationId, { permission: "catalog.manage" }),
    requireOrgAccess(planOrganizationId, { permission: "operations.read" }),
  ]);
  return !catalogAccess.error || !opsAccess.error;
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
