import { z } from "zod";

import {
  asFileActionError,
  postJson,
  putFileWithProgress,
} from "@/lib/documents/direct-upload";
import {
  FileActionError,
  friendlyFileError,
} from "@/lib/documents/file-errors";
import { validateUploadFile } from "@/lib/documents/file-policy";

/** Browser side of plan-material uploads: policy check, presign, PUT, then commit or replace. */

export type MaterialPlanKind =
  "consultation" | "subscription" | "webinar" | "class";

const PLURAL: Record<MaterialPlanKind, string> = {
  consultation: "consultations",
  subscription: "subscriptions",
  webinar: "webinars",
  class: "classes",
};

export function planMaterialsPath(kind: MaterialPlanKind, planId: string) {
  return `/api/plans/${PLURAL[kind]}/${encodeURIComponent(planId)}/materials`;
}

const PresignSchema = z.object({
  uploadUrl: z.string().url(),
  storagePath: z.string().min(1),
  mimeType: z.string().min(1),
});

async function uploadToPlan(
  kind: MaterialPlanKind,
  planId: string,
  file: File,
  onProgress?: (percent: number) => void,
) {
  const policy = validateUploadFile(file);
  if (!policy.ok) throw new FileActionError(friendlyFileError(policy.code));
  const res = await postJson(`${planMaterialsPath(kind, planId)}/upload-url`, {
    originalName: file.name,
    mimeType: policy.mimeType,
    fileSize: file.size,
  });
  const presign = PresignSchema.safeParse(await res.json());
  if (!presign.success) {
    throw new FileActionError(friendlyFileError("SERVER_ERROR"));
  }
  await putFileWithProgress(
    presign.data.uploadUrl,
    file,
    presign.data.mimeType,
    onProgress,
  );
  return {
    storagePath: presign.data.storagePath,
    originalName: file.name,
    mimeType: presign.data.mimeType,
    fileSize: file.size,
  };
}

/** Adds a file as the plan's next material. */
export async function addPlanMaterial(args: {
  kind: MaterialPlanKind;
  planId: string;
  file: File;
  onProgress?: (percent: number) => void;
}): Promise<void> {
  try {
    const uploaded = await uploadToPlan(
      args.kind,
      args.planId,
      args.file,
      args.onProgress,
    );
    await postJson(planMaterialsPath(args.kind, args.planId), uploaded);
  } catch (error) {
    throw asFileActionError(error);
  }
}

/** Replaces a material's file; its name, description and order stay. */
export async function replacePlanMaterial(args: {
  kind: MaterialPlanKind;
  planId: string;
  materialId: string;
  file: File;
}): Promise<void> {
  try {
    const uploaded = await uploadToPlan(args.kind, args.planId, args.file);
    await postJson(
      `/api/plans/materials/${encodeURIComponent(args.materialId)}`,
      uploaded,
      "PUT",
    );
  } catch (error) {
    throw asFileActionError(error);
  }
}
