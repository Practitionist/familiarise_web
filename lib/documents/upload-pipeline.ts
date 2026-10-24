import "server-only";

import { randomUUID } from "node:crypto";
import * as Sentry from "@sentry/nextjs";
import type { AppointmentDocument } from "@prisma/client";
import { z } from "zod";

import prisma, { type PrismaLike } from "@/lib/prisma";
import { deleteAppointmentDocument } from "@/lib/supabase-storage-core";
import { FileRouteError } from "./api-error";
import {
  documentWriteRefusal,
  resolveDocumentParty,
  type DocumentParty,
} from "./document-party";
import {
  ThreadSlotError,
  resolveDocumentThreadSlot,
  withVersionConflictRetry,
} from "./document-review";
import { MAX_FILE_BYTES, validateUploadFile } from "./file-policy";
import { verifyDirectUploadedObject } from "./storage-verify";
import { getDocumentViewerUrl } from "./urls";

/**
 * Presign-then-commit for session documents. The browser PUTs bytes straight
 * to storage; the commit verifies the object and writes the row under the
 * booking's `FOR UPDATE` lock, re-resolving the party and the window on `tx`.
 */

const fileFields = {
  originalName: z.string().trim().min(1).max(255),
  mimeType: z.string().trim().max(120),
  fileSize: z.number().int().nonnegative(),
  parentDocumentId: z.string().trim().min(1).nullish(),
};

export const UploadUrlRequestSchema = z.object(fileFields);

export const DocumentCommitSchema = z.object({
  ...fileFields,
  storagePath: z.string().trim().min(1),
  description: z.string().trim().max(2000).nullish(),
});
export type DocumentCommitInput = z.infer<typeof DocumentCommitSchema>;

/** The verified upload a reply or a commit persists. */
export const UploadedFileSchema = z.object({
  storagePath: z.string().trim().min(1),
  originalName: z.string().trim().min(1).max(255),
  mimeType: z.string().trim().max(120),
  fileSize: z.number().int().positive().max(MAX_FILE_BYTES),
});
export type UploadedFile = z.infer<typeof UploadedFileSchema>;

/** Applies the shared file policy to declared metadata; returns the resolved type. */
export function checkDeclaredFile(file: {
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

/** Each side uploads under its own folder; the commit only accepts that prefix. */
export function documentFolder(party: DocumentParty): string {
  const { booking } = party;
  return party.role === "expert"
    ? `appointments/${booking.id}/consultant-${booking.expert.profileId}`
    : `appointments/${booking.id}/consultee-${booking.learner.profileId}`;
}

/** Verifies the uploaded object belongs to this party and matches its declared type. */
export async function verifyPartyUpload(
  party: DocumentParty,
  file: UploadedFile,
): Promise<{ fileName: string; fileSize: number; mimeType: string }> {
  const mimeType = checkDeclaredFile(file);
  const verified = await verifyDirectUploadedObject({
    bucket: "documents",
    storagePath: file.storagePath,
    requiredPrefix: `${documentFolder(party)}/`,
    claimedMimeType: mimeType,
  });
  if (!verified.ok) throw new FileRouteError(verified.code);
  return verified;
}

/** Locks the booking row so slot allocation and state checks serialize per booking. */
export async function lockAppointment(
  tx: Pick<PrismaLike, "$executeRaw">,
  appointmentId: string,
): Promise<void> {
  await tx.$executeRaw`SELECT 1 FROM "Appointment" WHERE id = ${appointmentId} FOR UPDATE`;
}

/** Resolves the caller on `tx` and refuses when the booking no longer accepts writes. */
export async function requireWritableParty(
  tx: Pick<PrismaLike, "appointment">,
  appointmentId: string,
  userId: string,
): Promise<DocumentParty> {
  const party = await resolveDocumentParty(tx, appointmentId, userId);
  if (!party) throw new FileRouteError("NOT_FOUND");
  const refusal = documentWriteRefusal(party.booking);
  if (refusal) {
    throw new FileRouteError(
      refusal,
      refusal === "UPLOAD_WINDOW_CLOSED"
        ? party.booking.uploadWindowClosesAt
        : null,
    );
  }
  return party;
}

/** The row for a verified object; `fileUrl` holds the canonical viewer path, never a signed link. */
export function documentRowData(args: {
  appointmentId: string;
  party: DocumentParty;
  stored: { fileName: string; fileSize: number; mimeType: string };
  storagePath: string;
  originalName: string;
  description: string | null;
  parentDocumentId: string | null;
  rootDocumentId: string | null;
  versionNo: number;
}) {
  const id = randomUUID();
  const byExpert = args.party.role === "expert";
  return {
    id,
    appointmentId: args.appointmentId,
    fileName: args.stored.fileName,
    originalName: args.originalName,
    fileSize: args.stored.fileSize,
    mimeType: args.stored.mimeType,
    fileUrl: getDocumentViewerUrl(id),
    storagePath: args.storagePath,
    description: args.description,
    uploadedByRole: byExpert ? ("CONSULTANT" as const) : ("CONSULTEE" as const),
    responseToDocumentId: args.parentDocumentId,
    rootDocumentId: args.rootDocumentId,
    versionNo: args.versionNo,
    ...(byExpert
      ? {
          reviewStatus: "APPROVED" as const,
          reviewedById: args.party.userId,
          reviewedAt: new Date(),
        }
      : { reviewStatus: "PENDING" as const }),
  };
}

/** Deletes an uploaded object whose row was never written. */
export async function discardUpload(storagePath: string): Promise<void> {
  await deleteAppointmentDocument(storagePath).catch(() => false);
}

/**
 * A live row already committed for this object. A request replayed after a
 * lost response must return that row, never write a second one and never
 * delete the bytes the first request committed.
 */
export async function findCommittedUpload(
  tx: Pick<PrismaLike, "appointmentDocument">,
  appointmentId: string,
  storagePath: string,
): Promise<AppointmentDocument | null> {
  return tx.appointmentDocument.findFirst({
    where: { appointmentId, storagePath, deletedAt: null },
  });
}

/** Best-effort delete of a refused commit's object: only the caller's own folder, never a committed file. */
export async function discardRefusedUpload(args: {
  appointmentId: string;
  userId: string;
  storagePath: string;
}): Promise<void> {
  try {
    const party = await resolveDocumentParty(
      prisma,
      args.appointmentId,
      args.userId,
    );
    if (!party) return;
    const path = args.storagePath;
    if (!path.startsWith(`${documentFolder(party)}/`) || path.includes(".."))
      return;
    const committed = await prisma.appointmentDocument.count({
      where: { storagePath: path },
    });
    if (committed === 0) await discardUpload(path);
  } catch {
    // Best-effort: an orphan left here only costs storage.
  }
}

/**
 * Writes a learner document or version, or an expert's shared file. Expert
 * replies go through the review route so status and reply land together.
 */
export async function commitDocumentUpload(args: {
  appointmentId: string;
  userId: string;
  input: DocumentCommitInput;
}): Promise<{
  document: AppointmentDocument;
  party: DocumentParty;
  replayed: boolean;
}> {
  const { appointmentId, userId, input } = args;
  const parentDocumentId = input.parentDocumentId ?? null;

  const preflight = await resolveDocumentParty(prisma, appointmentId, userId);
  if (!preflight) throw new FileRouteError("NOT_FOUND");
  if (preflight.role === "expert" && parentDocumentId) {
    throw new FileRouteError("INVALID_INPUT");
  }

  try {
    // A retry whose row already exists replays before storage verification:
    // the object may have been swept, and the committed row is still the answer.
    const committed = await findCommittedUpload(
      prisma,
      appointmentId,
      input.storagePath,
    );
    if (committed) {
      return { document: committed, party: preflight, replayed: true };
    }

    const stored = await verifyPartyUpload(preflight, input);
    return await withVersionConflictRetry(() =>
      prisma.$transaction(async (tx) => {
        await lockAppointment(tx, appointmentId);
        const replayed = await findCommittedUpload(
          tx,
          appointmentId,
          input.storagePath,
        );
        if (replayed) {
          const party = await resolveDocumentParty(tx, appointmentId, userId);
          if (!party) throw new FileRouteError("NOT_FOUND");
          return { document: replayed, party, replayed: true };
        }
        const party = await requireWritableParty(tx, appointmentId, userId);
        const slot = await resolveDocumentThreadSlot(tx, {
          appointmentId,
          parentDocumentId,
          uploadedByRole: party.role === "expert" ? "CONSULTANT" : "CONSULTEE",
        });
        const document = await tx.appointmentDocument.create({
          data: documentRowData({
            appointmentId,
            party,
            stored,
            storagePath: input.storagePath,
            originalName: input.originalName,
            description: input.description?.trim() || null,
            parentDocumentId,
            rootDocumentId: slot.rootDocumentId,
            versionNo: slot.versionNo,
          }),
        });
        return { document, party, replayed: false };
      }),
    );
  } catch (error) {
    // A storage timeout does not prove the object is bad; keep it so the
    // client can retry the commit without uploading again.
    const storageUnavailable =
      error instanceof FileRouteError && error.code === "STORAGE_UNAVAILABLE";
    if (!storageUnavailable) {
      await discardRefusedUpload({
        appointmentId,
        userId,
        storagePath: input.storagePath,
      });
    }
    if (error instanceof ThreadSlotError) {
      throw new FileRouteError(error.code);
    }
    if (error instanceof FileRouteError) throw error;
    Sentry.captureException(error, { tags: { subsystem: "documents" } });
    throw new FileRouteError("SERVER_ERROR");
  }
}
