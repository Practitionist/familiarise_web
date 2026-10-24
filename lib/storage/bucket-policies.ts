/**
 * One explicit policy per storage bucket the app provisions. A bucket without
 * an entry is refused, never created with a fallback, because the old default
 * created any unlisted bucket public and exposed every object it held.
 *
 * Documents use the session-document allowlist, so a bucket and the route that
 * writes to it can never disagree about what is allowed.
 */

import {
  ALLOWED_FILE_MIME_TYPES,
  MAX_FILE_BYTES,
} from "@/lib/documents/file-policy";
import {
  SUPPORT_ATTACHMENT_MAX_BYTES,
  SUPPORT_ATTACHMENT_MIME_TYPES,
} from "@/lib/support/attachment-policy";

const MB = 1024 * 1024;
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;

export interface BucketPolicy {
  public: boolean;
  fileSizeLimit: number;
  allowedMimeTypes?: readonly string[];
}

export const BUCKET_POLICIES = {
  documents: {
    public: false,
    fileSizeLimit: MAX_FILE_BYTES,
    allowedMimeTypes: [...ALLOWED_FILE_MIME_TYPES],
  },
  "plan-images": {
    public: true,
    fileSizeLimit: 5 * MB,
    allowedMimeTypes: [...IMAGE_TYPES],
  },
  "profile-images": {
    public: true,
    fileSizeLimit: 2 * MB,
    allowedMimeTypes: [...IMAGE_TYPES],
  },
  "organization-images": {
    public: true,
    fileSizeLimit: 5 * MB,
    allowedMimeTypes: [...IMAGE_TYPES, "image/svg+xml"],
  },
  "recordings-previews": {
    public: true,
    fileSizeLimit: 50 * MB,
    allowedMimeTypes: ["video/mp4", "video/webm", ...IMAGE_TYPES],
  },
  "support-attachments": {
    public: false,
    fileSizeLimit: SUPPORT_ATTACHMENT_MAX_BYTES,
    allowedMimeTypes: [...SUPPORT_ATTACHMENT_MIME_TYPES],
  },
} as const satisfies Record<string, BucketPolicy>;

/** The policy for a listed bucket, or a caller override merged over it. */
export function bucketPolicyFor(
  bucketName: string,
  override?: {
    public?: boolean;
    fileSizeLimit?: number;
    allowedMimeTypes?: readonly string[];
  },
): BucketPolicy | null {
  const base = (BUCKET_POLICIES as Record<string, BucketPolicy | undefined>)[
    bucketName
  ];
  // A bucket with no entry is not provisioned, even when the caller supplies
  // options: adding the bucket to the registry is the review gate.
  if (!base) return null;
  return {
    public: override?.public ?? base.public,
    fileSizeLimit: override?.fileSizeLimit ?? base.fileSizeLimit,
    allowedMimeTypes: override?.allowedMimeTypes ?? base.allowedMimeTypes,
  };
}
