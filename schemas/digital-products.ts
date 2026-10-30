import { z } from "zod";
import { DigitalProductCategory } from "@prisma/client";
import {
  DIGITAL_PRODUCT_MAX_FILE_BYTES,
  DIGITAL_PRODUCT_MAX_FILES,
  DIGITAL_PRODUCT_MIN_PAID_PRICE_PAISE,
  isDigitalProductMime,
  type DigitalProductMimeType,
} from "@/lib/digital-products/constants";

/** ₹5,00,000 ceiling on a single file sale. */
const MAX_PRICE_PAISE = 50_000_000;

/** The cover is written only by /api/plans/image, so it always names a plan-images object. */
const productFields = {
  title: z.string().trim().min(3).max(120),
  subtitle: z.string().trim().max(200).nullable().optional(),
  description: z.string().trim().min(10).max(10_000),
  category: z.nativeEnum(DigitalProductCategory),
  pricePaise: z
    .number()
    .int()
    .min(0)
    .max(MAX_PRICE_PAISE)
    .refine((p) => p === 0 || p >= DIGITAL_PRODUCT_MIN_PAID_PRICE_PAISE, {
      message: "A paid product costs at least ₹1",
    }),
};

export const createDigitalProductSchema = z.object(productFields).strict();

export const updateDigitalProductSchema = z
  .object({
    ...productFields,
    previewAssetId: z.string().min(1).nullable(),
  })
  .partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "Nothing to update",
  });

const mimeTypeSchema = z.custom<DigitalProductMimeType>(
  (value) => typeof value === "string" && isDigitalProductMime(value),
  { message: "Unsupported file type" },
);

export const assetUploadRequestSchema = z
  .object({
    fileName: z.string().trim().min(1).max(255),
    mimeType: mimeTypeSchema,
    sizeBytes: z.number().int().positive().max(DIGITAL_PRODUCT_MAX_FILE_BYTES),
  })
  .strict();

export const reorderAssetsSchema = z
  .object({
    assetIds: z
      .array(z.string().min(1))
      .min(1)
      .max(DIGITAL_PRODUCT_MAX_FILES)
      .refine((ids) => new Set(ids).size === ids.length, {
        message: "Duplicate asset ids",
      }),
  })
  .strict();

export const reportDigitalProductSchema = z
  .object({ reason: z.string().trim().min(10).max(2000) })
  .strict();
