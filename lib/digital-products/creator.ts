import { randomBytes, randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import type { z } from "zod";
import type {
  DigitalProductCategory,
  DigitalProductStatus,
} from "@prisma/client";
import prisma from "@/lib/prisma";
import { requireApiAuth } from "@/lib/auth-helpers";
import { createR2PresignedPutUrl } from "@/lib/storage/r2-client";
import {
  DIGITAL_PRODUCT_MAX_FILES,
  DIGITAL_PRODUCT_MAX_TOTAL_BYTES,
  DIGITAL_PRODUCT_UPLOAD_URL_TTL_SECONDS,
  digitalProductAssetKey,
  lineageFolder,
  mimePolicy,
  type DigitalProductMimeType,
} from "@/lib/digital-products/constants";
import { digitalProductsBucket } from "@/lib/digital-products/storage";

export interface OwnedProduct {
  id: string;
  consultantProfileId: string;
  status: DigitalProductStatus;
  category: DigitalProductCategory;
  takenDownAt: Date | null;
}

export function jsonError(status: number, code: string, error: string) {
  return NextResponse.json({ error, code }, { status });
}

/** Parse a JSON body through `schema`; a malformed body is a 400, never a throw. */
export async function parseBody<S extends z.ZodTypeAny>(
  request: Request,
  schema: S,
): Promise<
  { ok: true; data: z.infer<S> } | { ok: false; error: NextResponse }
> {
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return {
      ok: false,
      error: NextResponse.json(
        {
          error: "Invalid request",
          code: "INVALID_INPUT",
          issues: parsed.error.issues,
        },
        { status: 400 },
      ),
    };
  }
  return { ok: true, data: parsed.data };
}

/** The signed-in consultant and their own product; anyone else gets 404. */
export async function requireOwnedProduct(
  productId: string,
): Promise<
  | { ok: true; product: OwnedProduct; userId: string }
  | { ok: false; error: NextResponse }
> {
  const auth = await requireApiAuth();
  if (auth.error) return { ok: false, error: auth.error };
  const consultantProfileId = auth.session.user.consultantProfileId;
  const product = consultantProfileId
    ? await prisma.digitalProduct.findFirst({
        where: { id: productId, consultantProfileId },
        select: {
          id: true,
          consultantProfileId: true,
          status: true,
          category: true,
          takenDownAt: true,
        },
      })
    : null;
  if (!product) {
    return {
      ok: false,
      error: jsonError(404, "NOT_FOUND", "Product not found"),
    };
  }
  return { ok: true, product, userId: auth.session.user.id };
}

/** A URL slug from the title plus a random suffix, so two titles never collide. */
export function productSlug(title: string): string {
  const base = title
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  const suffix = randomBytes(4).toString("hex");
  return base ? `${base}-${suffix}` : suffix;
}

export type UploadRefusal =
  "CATEGORY_MISMATCH" | "TOO_MANY_FILES" | "PRODUCT_TOO_LARGE";

export const UPLOAD_REFUSAL_MESSAGES: Record<UploadRefusal, string> = {
  CATEGORY_MISMATCH: "This file type does not fit the product's category",
  TOO_MANY_FILES: "A product holds at most 20 files",
  PRODUCT_TOO_LARGE: "A product holds at most 1 GB of files",
};

/** Whether one more file fits the product's file and byte caps; `replacing` frees its own slot. */
export async function checkUploadFits(params: {
  product: OwnedProduct;
  mimeType: DigitalProductMimeType;
  sizeBytes: number;
  replacing?: { id: string; sizeBytes: number };
}): Promise<UploadRefusal | null> {
  const { product, mimeType, sizeBytes, replacing } = params;
  if (!mimePolicy(mimeType).categories.some((c) => c === product.category)) {
    return "CATEGORY_MISMATCH";
  }
  const live = await prisma.digitalProductAsset.findMany({
    where: { productId: product.id, status: { in: ["PENDING", "VERIFIED"] } },
    select: { id: true, sizeBytes: true },
  });
  const others = live.filter((a) => a.id !== replacing?.id);
  if (!replacing && others.length >= DIGITAL_PRODUCT_MAX_FILES) {
    return "TOO_MANY_FILES";
  }
  const total = others.reduce((sum, a) => sum + a.sizeBytes, 0);
  return total + sizeBytes > DIGITAL_PRODUCT_MAX_TOTAL_BYTES
    ? "PRODUCT_TOO_LARGE"
    : null;
}

/**
 * Create the PENDING asset row and presign the browser's PUT. A replacement
 * keeps the replaced file's folder and bumps its version.
 */
export async function createPendingAsset(params: {
  productId: string;
  fileName: string;
  mimeType: DigitalProductMimeType;
  sizeBytes: number;
  order: number;
  replaces?: { storageKey: string; version: number };
}): Promise<{
  assetId: string;
  uploadUrl: string;
  headers: Record<string, string>;
}> {
  const assetId = randomUUID();
  const version = (params.replaces?.version ?? 0) + 1;
  const storageKey = params.replaces
    ? `${lineageFolder(params.replaces.storageKey)}v${version}.${mimePolicy(params.mimeType).extension}`
    : digitalProductAssetKey({
        productId: params.productId,
        assetId,
        version,
        mimeType: params.mimeType,
      });
  await prisma.digitalProductAsset.create({
    data: {
      id: assetId,
      productId: params.productId,
      storageKey,
      originalName: params.fileName,
      mimeType: params.mimeType,
      sizeBytes: params.sizeBytes,
      order: params.order,
      version,
      status: "PENDING",
    },
  });
  // The browser must send exactly these; content-length follows from the body.
  const headers = { "Content-Type": params.mimeType };
  const uploadUrl = createR2PresignedPutUrl({
    key: storageKey,
    bucket: digitalProductsBucket(),
    contentType: params.mimeType,
    contentLength: params.sizeBytes,
    expiresInSeconds: DIGITAL_PRODUCT_UPLOAD_URL_TTL_SECONDS,
  });
  return { assetId, uploadUrl, headers };
}
