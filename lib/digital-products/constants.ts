import type { DigitalProductCategory } from "@prisma/client";

/** 250 MB; prisma/sql/check-constraints.sql pins the same cap on the column. */
export const DIGITAL_PRODUCT_MAX_FILE_BYTES = 250 * 1024 * 1024;
export const DIGITAL_PRODUCT_MAX_FILES = 20;
export const DIGITAL_PRODUCT_MAX_TOTAL_BYTES = 1024 * 1024 * 1024;

/** Lifetime of the presigned PUT a creator uploads one file with. */
export const DIGITAL_PRODUCT_UPLOAD_URL_TTL_SECONDS = 15 * 60;
/** Lifetime of the presigned GET a buyer downloads one file with. */
export const DIGITAL_PRODUCT_DOWNLOAD_URL_TTL_SECONDS = 300;

export const ZIP_LIMITS = {
  maxEntries: 1000,
  maxTotalUncompressedBytes: 500 * 1024 * 1024,
  maxEntryRatio: 100,
  /** Entries smaller than this cannot hold a bomb, so the ratio rule skips them. */
  ratioFloorBytes: 1024 * 1024,
  /** The EOCD sits in the last 22 bytes plus a comment of at most 64 KiB. */
  eocdSearchBytes: 22 + 0xffff,
  /** 1,000 entries with generous names and extras fit well inside this. */
  maxCentralDirectoryBytes: 4 * 1024 * 1024,
} as const;

interface AllowedMime {
  extension: string;
  categories: readonly DigitalProductCategory[];
  /** A ZIP container whose central directory is inspected on commit. */
  zipContainer?: "archive" | "document";
}

const TEXT_CATEGORIES = ["DOCUMENT", "TEMPLATE"] as const;

/** Every MIME a product file may carry. SVG (executable markup) and video are excluded. */
export const DIGITAL_PRODUCT_MIME_TYPES = {
  "application/pdf": { extension: "pdf", categories: TEXT_CATEGORIES },
  "application/epub+zip": {
    extension: "epub",
    categories: TEXT_CATEGORIES,
    zipContainer: "document",
  },
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": {
    extension: "docx",
    categories: TEXT_CATEGORIES,
    zipContainer: "document",
  },
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": {
    extension: "xlsx",
    categories: TEXT_CATEGORIES,
    zipContainer: "document",
  },
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": {
    extension: "pptx",
    categories: TEXT_CATEGORIES,
    zipContainer: "document",
  },
  "text/plain": { extension: "txt", categories: TEXT_CATEGORIES },
  "text/csv": { extension: "csv", categories: TEXT_CATEGORIES },
  "text/markdown": { extension: "md", categories: TEXT_CATEGORIES },
  "application/zip": {
    extension: "zip",
    categories: ["ARCHIVE", "TEMPLATE"],
    zipContainer: "archive",
  },
  "image/png": { extension: "png", categories: ["IMAGE", "TEMPLATE"] },
  "image/jpeg": { extension: "jpg", categories: ["IMAGE", "TEMPLATE"] },
  "image/webp": { extension: "webp", categories: ["IMAGE", "TEMPLATE"] },
  "audio/mpeg": { extension: "mp3", categories: ["AUDIO"] },
  "audio/mp4": { extension: "m4a", categories: ["AUDIO"] },
  "audio/wav": { extension: "wav", categories: ["AUDIO"] },
} as const satisfies Record<string, AllowedMime>;

export type DigitalProductMimeType = keyof typeof DIGITAL_PRODUCT_MIME_TYPES;

export function isDigitalProductMime(
  mimeType: string,
): mimeType is DigitalProductMimeType {
  return Object.hasOwn(DIGITAL_PRODUCT_MIME_TYPES, mimeType);
}

export function mimePolicy(mimeType: DigitalProductMimeType): AllowedMime {
  return DIGITAL_PRODUCT_MIME_TYPES[mimeType];
}

/** R2 object key; the extension comes from the MIME, never from the uploader's name. */
export function digitalProductAssetKey(params: {
  productId: string;
  assetId: string;
  version: number;
  mimeType: DigitalProductMimeType;
}): string {
  const { extension } = DIGITAL_PRODUCT_MIME_TYPES[params.mimeType];
  return `products/${params.productId}/${params.assetId}/v${params.version}.${extension}`;
}

export const DIGITAL_PRODUCT_KEY_PREFIX = "products/";

/** The folder a version lineage shares: everything before `v<version>.<ext>`. */
export function lineageFolder(storageKey: string): string {
  return storageKey.slice(0, storageKey.lastIndexOf("/") + 1);
}
