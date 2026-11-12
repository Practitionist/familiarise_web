import type { DigitalProductCategory } from "@prisma/client";
import { goLibraryHref } from "@/lib/dashboard/go";

/** 250 MB; a CHECK in prisma/migrations pins the same cap on the column. */
export const DIGITAL_PRODUCT_MAX_FILE_BYTES = 250 * 1024 * 1024;
export const DIGITAL_PRODUCT_MAX_FILES = 20;
export const DIGITAL_PRODUCT_MAX_TOTAL_BYTES = 1024 * 1024 * 1024;
/** Razorpay's ₹1 order floor; CHECK `digital_product_price_free_or_min_paid` enforces free or at least this. */
export const DIGITAL_PRODUCT_MIN_PAID_PRICE_PAISE = 100;

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
  /** Bit-3 entries are read (stored scanned, DEFLATE inflated); their compressed total is capped here. */
  maxDeepScanCompressedBytes: 64 * 1024 * 1024,
} as const;

interface AllowedMime {
  extension: string;
  categories: readonly DigitalProductCategory[];
  /** A ZIP container whose central directory is inspected on commit. */
  zipContainer?: "archive" | "document";
}

export const DIGITAL_PRODUCT_CATEGORY_LABEL: Record<
  DigitalProductCategory,
  string
> = {
  DOCUMENT: "Document",
  TEMPLATE: "Template",
  ARCHIVE: "ZIP bundle",
  IMAGE: "Images",
  AUDIO: "Audio",
};

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

/**
 * R2 object key, fresh for every upload and written once; the extension comes
 * from the MIME, never from the uploader's name.
 */
export function digitalProductAssetKey(params: {
  productId: string;
  lineageId: string;
  assetId: string;
  mimeType: DigitalProductMimeType;
}): string {
  const { extension } = DIGITAL_PRODUCT_MIME_TYPES[params.mimeType];
  return `products/${params.productId}/${params.lineageId}/${params.assetId}.${extension}`;
}

export const DIGITAL_PRODUCT_KEY_PREFIX = "products/";

const EXTENSION_MIME = new Map<string, DigitalProductMimeType>([
  ["jpeg", "image/jpeg"],
]);
for (const mime of Object.keys(DIGITAL_PRODUCT_MIME_TYPES)) {
  if (isDigitalProductMime(mime)) {
    EXTENSION_MIME.set(DIGITAL_PRODUCT_MIME_TYPES[mime].extension, mime);
  }
}

/**
 * The allowed MIME for a browser-picked file: its extension decides, since
 * browsers report `.md`, `.csv` and `.m4a` inconsistently or not at all.
 */
export function resolveDigitalProductMime(
  fileName: string,
  browserType: string,
): DigitalProductMimeType | null {
  const ext = fileName.includes(".")
    ? fileName.slice(fileName.lastIndexOf(".") + 1).toLowerCase()
    : "";
  const byExtension = EXTENSION_MIME.get(ext);
  if (byExtension) return byExtension;
  return isDigitalProductMime(browserType) ? browserType : null;
}

/** Whether a file of this MIME may go into a product of this category. */
export function mimeFitsCategory(
  mimeType: DigitalProductMimeType,
  category: DigitalProductCategory,
): boolean {
  return DIGITAL_PRODUCT_MIME_TYPES[mimeType].categories.some(
    (c) => c === category,
  );
}

/** The file-picker `accept` list for one category. */
export function digitalProductAcceptAttr(
  category: DigitalProductCategory,
): string {
  return Object.keys(DIGITAL_PRODUCT_MIME_TYPES)
    .filter(isDigitalProductMime)
    .filter((mime) => mimeFitsCategory(mime, category))
    .flatMap((mime) => [mime, `.${DIGITAL_PRODUCT_MIME_TYPES[mime].extension}`])
    .join(",");
}

/** The file extensions a category takes, for messages: "PDF, EPUB, DOCX". */
export function allowedExtensionsFor(
  category: DigitalProductCategory,
): string[] {
  return Object.keys(DIGITAL_PRODUCT_MIME_TYPES)
    .filter(isDigitalProductMime)
    .filter((mime) => mimeFitsCategory(mime, category))
    .map((mime) => DIGITAL_PRODUCT_MIME_TYPES[mime].extension.toUpperCase());
}

/** "The Document category takes PDF, EPUB, … files." */
export function categoryFileRule(category: DigitalProductCategory): string {
  return `The ${DIGITAL_PRODUCT_CATEGORY_LABEL[category]} category takes ${allowedExtensionsFor(category).join(", ")} files.`;
}

/** What an owner sees wherever a buyer would buy or claim their own product. */
export function ownProductNotice(free: boolean): string {
  return `This is your own product — buyers will see ${free ? "a Get for free" : "a Buy"} button here.`;
}

/** The buyer's Library › Purchases; null when they have no personal dashboard yet. */
export function digitalProductLibraryHref(user: {
  consulteeProfileId?: string | null;
  consultantProfileId?: string | null;
}): string | null {
  return user.consulteeProfileId || user.consultantProfileId
    ? goLibraryHref("purchases")
    : null;
}

/** Next data-cache tag of the public products listing. */
export const PUBLIC_PRODUCTS_TAG = "digital-products";
