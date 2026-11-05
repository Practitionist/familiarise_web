import { randomBytes, randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import type { z } from "zod";
import type {
  DigitalProductCategory,
  DigitalProductStatus,
} from "@prisma/client";
import prisma, { type Tx } from "@/lib/prisma";
import { lockDigitalProductRow } from "@/lib/digital-products/product-lock";
import { requireApiAuth } from "@/lib/auth-helpers";
import {
  createR2PresignedPutUrl,
  R2_CREATE_ONLY_HEADER,
} from "@/lib/storage/r2-client";
import {
  DIGITAL_PRODUCT_MAX_FILES,
  DIGITAL_PRODUCT_MAX_TOTAL_BYTES,
  DIGITAL_PRODUCT_UPLOAD_URL_TTL_SECONDS,
  categoryFileRule,
  digitalProductAssetKey,
  mimeFitsCategory,
  type DigitalProductMimeType,
} from "@/lib/digital-products/constants";
import { digitalProductsBucket } from "@/lib/digital-products/storage";

export interface OwnedProduct {
  id: string;
  consultantProfileId: string;
  slug: string;
  status: DigitalProductStatus;
  category: DigitalProductCategory;
  takenDownAt: Date | null;
}

export function jsonError(
  status: number,
  code: string,
  error: string,
  extra?: Record<string, unknown>,
) {
  return NextResponse.json({ error, code, ...extra }, { status });
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
          slug: true,
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
  | "CATEGORY_MISMATCH"
  | "TAKEN_DOWN"
  | "TOO_MANY_FILES"
  | "PRODUCT_TOO_LARGE"
  | "NOT_FOUND";

export interface UploadRefusalResult {
  ok: false;
  refusal: UploadRefusal;
  category?: DigitalProductCategory;
  /** Live (PENDING or VERIFIED) files, on TOO_MANY_FILES. */
  current?: number;
}

const UPLOAD_REFUSAL_MESSAGES: Record<UploadRefusal, string> = {
  CATEGORY_MISMATCH: "This file type does not fit the product's category",
  TAKEN_DOWN: "This product was taken down",
  TOO_MANY_FILES: `A product holds at most ${DIGITAL_PRODUCT_MAX_FILES} files`,
  PRODUCT_TOO_LARGE: "A product holds at most 1 GB of files",
  NOT_FOUND: "Product or verified file not found",
};

/** The 404/409 an upload or replace refusal answers with, its numbers included. */
export function uploadRefusalResponse(result: UploadRefusalResult) {
  const { refusal, category, current } = result;
  if (refusal === "CATEGORY_MISMATCH" && category) {
    return jsonError(409, refusal, categoryFileRule(category), { category });
  }
  if (refusal === "TOO_MANY_FILES") {
    return jsonError(409, refusal, UPLOAD_REFUSAL_MESSAGES[refusal], {
      limit: DIGITAL_PRODUCT_MAX_FILES,
      current,
    });
  }
  return jsonError(
    refusal === "NOT_FOUND" ? 404 : 409,
    refusal,
    UPLOAD_REFUSAL_MESSAGES[refusal],
  );
}

/** Whether one more file fits the product's file and byte caps; `replacing` frees its own slot. */
async function checkUploadFits(
  tx: Tx,
  params: {
    productId: string;
    sizeBytes: number;
    replacing?: { id: string };
  },
): Promise<Omit<UploadRefusalResult, "ok"> | null> {
  const { productId, sizeBytes, replacing } = params;
  const live = await tx.digitalProductAsset.findMany({
    where: { productId, status: { in: ["PENDING", "VERIFIED"] } },
    select: { id: true, sizeBytes: true },
  });
  const others = live.filter((a) => a.id !== replacing?.id);
  if (!replacing && others.length >= DIGITAL_PRODUCT_MAX_FILES) {
    return { refusal: "TOO_MANY_FILES", current: live.length };
  }
  const total = others.reduce((sum, a) => sum + a.sizeBytes, 0);
  return total + sizeBytes > DIGITAL_PRODUCT_MAX_TOTAL_BYTES
    ? { refusal: "PRODUCT_TOO_LARGE" }
    : null;
}

/**
 * Check the category, takedown and caps and reserve a PENDING asset under the
 * product row lock, then presign a create-only PUT to its fresh key. A
 * replacement joins the replaced file's lineage at the next version of every
 * upload that lineage ever had.
 */
export async function reservePendingAsset(params: {
  product: OwnedProduct;
  fileName: string;
  mimeType: DigitalProductMimeType;
  sizeBytes: number;
  replacesAssetId?: string;
}): Promise<
  | {
      ok: true;
      upload: {
        assetId: string;
        uploadUrl: string;
        headers: Record<string, string>;
      };
    }
  | UploadRefusalResult
> {
  const { product, mimeType, sizeBytes, replacesAssetId } = params;
  const assetId = randomUUID();
  const reserved = await prisma.$transaction(
    async (
      tx,
    ): Promise<{ storageKey: string } | Omit<UploadRefusalResult, "ok">> => {
      await lockDigitalProductRow(tx, product.id);
      // Re-read under the lock: a draft's category change serialises on the same row.
      const locked = await tx.digitalProduct.findUnique({
        where: { id: product.id },
        select: { category: true, takenDownAt: true },
      });
      if (!locked) return { refusal: "NOT_FOUND" };
      if (locked.takenDownAt) return { refusal: "TAKEN_DOWN" };
      if (!mimeFitsCategory(mimeType, locked.category)) {
        return { refusal: "CATEGORY_MISMATCH", category: locked.category };
      }
      const current = replacesAssetId
        ? await tx.digitalProductAsset.findFirst({
            where: {
              id: replacesAssetId,
              productId: product.id,
              status: "VERIFIED",
            },
            select: { id: true, lineageId: true, order: true },
          })
        : null;
      if (replacesAssetId && !current) return { refusal: "NOT_FOUND" };
      const refusal = await checkUploadFits(tx, {
        productId: product.id,
        sizeBytes,
        ...(current ? { replacing: current } : {}),
      });
      if (refusal) return refusal;

      let lineageId: string = assetId;
      let version = 1;
      let order: number;
      if (current) {
        const lineage = await tx.digitalProductAsset.aggregate({
          where: { lineageId: current.lineageId },
          _max: { version: true },
        });
        lineageId = current.lineageId;
        version = (lineage._max.version ?? 0) + 1;
        order = current.order;
      } else {
        const last = await tx.digitalProductAsset.findFirst({
          where: { productId: product.id },
          orderBy: { order: "desc" },
          select: { order: true },
        });
        order = (last?.order ?? -1) + 1;
      }
      const storageKey = digitalProductAssetKey({
        productId: product.id,
        lineageId,
        assetId,
        mimeType,
      });
      await tx.digitalProductAsset.create({
        data: {
          id: assetId,
          productId: product.id,
          lineageId,
          storageKey,
          originalName: params.fileName,
          mimeType,
          sizeBytes,
          order,
          version,
          status: "PENDING",
        },
      });
      return { storageKey };
    },
  );
  if ("refusal" in reserved) return { ok: false, ...reserved };

  // The browser must send exactly these; content-length follows from the body.
  const headers = { "Content-Type": mimeType, ...R2_CREATE_ONLY_HEADER };
  const uploadUrl = createR2PresignedPutUrl({
    key: reserved.storageKey,
    bucket: digitalProductsBucket(),
    contentType: mimeType,
    contentLength: sizeBytes,
    expiresInSeconds: DIGITAL_PRODUCT_UPLOAD_URL_TTL_SECONDS,
    createOnly: true,
  });
  return { ok: true, upload: { assetId, uploadUrl, headers } };
}
