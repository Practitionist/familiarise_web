/**
 * @jest-environment node
 */

/**
 * Creator doors: only the owning consultant reaches a product, publishing
 * needs a verified file (CAS on status), an upload reserves a PENDING file
 * under a fresh key, and a replacement takes the next version of its lineage.
 */
jest.mock("../../lib/auth-helpers", () => ({
  requireApiAuth: jest.fn(async () => ({
    session: { user: { id: "u_owner", consultantProfileId: "cp_owner" } },
  })),
}));
jest.mock("../../lib/rate-limit", () => ({
  applyRateLimit: async () => null,
  digitalProductUploadLimiter: {},
}));
const presignPut = jest.fn(
  (_opts: Record<string, unknown>) => "https://r2/put",
);
jest.mock("../../lib/storage/r2-client", () => ({
  createR2PresignedPutUrl: (opts: Record<string, unknown>) => presignPut(opts),
  R2_CREATE_ONLY_HEADER: { "If-None-Match": "*" },
}));

const product = {
  id: "dp_1",
  consultantProfileId: "cp_owner",
  slug: "guide-1",
  status: "DRAFT",
  category: "DOCUMENT",
  takenDownAt: null,
};
const publish = jest.fn();
const assetCreate = jest.fn(async ({ data }: { data: object }) => data);
const liveAssets: Array<{ id: string; sizeBytes: number }> = [];
const assetModel = {
  findMany: async () => liveAssets,
  findFirst: async ({ where }: { where: { id?: string } }) =>
    where.id === "as_1"
      ? {
          id: "as_1",
          lineageId: "lin_1",
          storageKey: "products/dp_1/lin_1/as_1.pdf",
          version: 1,
          order: 3,
          sizeBytes: 1000,
        }
      : where.id
        ? null
        : { order: 3 },
  aggregate: async () => ({ _max: { version: 1 } }),
  create: (...a: [{ data: object }]) => assetCreate(...a),
};
const purchases: Array<{
  status: string;
  gatewayOrderId: string | null;
  paymentId: string | null;
}> = [];
const productDelete = jest.fn(async () => product);
const purchaseDeleteMany = jest.fn(async () => ({ count: 0 }));
const cancelOrder = jest.fn(async (_id: string) => "no_live_payment");
jest.mock("../../lib/payments/core/razorpay", () => ({
  cancelRazorpayOrder: (id: string) => cancelOrder(id),
}));
const tx = {
  digitalProductAsset: assetModel,
  digitalProduct: {
    findUnique: async () => product,
    updateMany: (...a: unknown[]) => publish(...a),
    delete: (...a: unknown[]) => productDelete(...(a as [])),
  },
  digitalProductPurchase: {
    findFirst: async () =>
      purchases.find(
        (p) =>
          p.status === "SUCCEEDED" ||
          p.status === "REFUNDED" ||
          p.paymentId !== null,
      ) ?? null,
    findMany: async () =>
      purchases.filter((p) => p.status === "PENDING" || p.status === "FAILED"),
    deleteMany: (...a: unknown[]) => purchaseDeleteMany(...(a as [])),
  },
  $executeRaw: async () => 1,
};
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    $transaction: (cb: (t: typeof tx) => Promise<unknown>) => cb(tx),
    digitalProduct: {
      findFirst: async ({
        where,
      }: {
        where: { consultantProfileId: string };
      }) =>
        where.consultantProfileId === product.consultantProfileId
          ? product
          : null,
      updateMany: (...a: unknown[]) => publish(...a),
    },
  },
}));

import { requireApiAuth } from "../../lib/auth-helpers";
import { POST as publishRoute } from "../../app/api/digital-products/[productId]/publish/route";
import { POST as uploadUrl } from "../../app/api/digital-products/[productId]/assets/upload-url/route";
import { POST as replace } from "../../app/api/digital-products/[productId]/assets/[assetId]/replace/route";
import { DELETE as deleteProduct } from "../../app/api/digital-products/[productId]/route";

const params = { params: Promise.resolve({ productId: "dp_1" }) };
const json = (body: unknown) =>
  new Request("http://localhost/x", {
    method: "POST",
    body: JSON.stringify(body),
  });

beforeEach(() => {
  jest.clearAllMocks();
  purchases.length = 0;
  process.env.R2_DIGITAL_PRODUCTS_BUCKET = "digital-products";
});

it("gates on ownership and publishes only with a verified file", async () => {
  jest.mocked(requireApiAuth).mockResolvedValueOnce({
    session: { user: { id: "u_other", consultantProfileId: "cp_other" } },
  } as Awaited<ReturnType<typeof requireApiAuth>>);
  expect((await publishRoute(json({}), params)).status).toBe(404);

  publish.mockResolvedValueOnce({ count: 0 });
  const refused = await publishRoute(json({}), params);
  expect(refused.status).toBe(409);
  expect((await refused.json()).code).toBe("NO_VERIFIED_FILE");
  expect(publish).toHaveBeenCalledWith({
    where: {
      id: "dp_1",
      status: { in: ["DRAFT", "ARCHIVED"] },
      takenDownAt: null,
      assets: { some: { status: "VERIFIED" } },
    },
    data: expect.objectContaining({ status: "PUBLISHED" }),
  });
});

it("reserves a PENDING file under a fresh key and versions a replacement in its lineage", async () => {
  const mismatch = await uploadUrl(
    json({ fileName: "song.mp3", mimeType: "audio/mpeg", sizeBytes: 10 }),
    params,
  );
  expect((await mismatch.json()).code).toBe("CATEGORY_MISMATCH");

  const created = await uploadUrl(
    json({
      fileName: "Guide.PDF.exe",
      mimeType: "application/pdf",
      sizeBytes: 2048,
    }),
    params,
  );
  expect(created.status).toBe(201);
  const first = assetCreate.mock.calls[0][0].data as {
    storageKey: string;
    status: string;
  };
  expect(first.storageKey).toMatch(
    /^products\/dp_1\/([0-9a-f-]{36})\/\1\.pdf$/,
  );
  expect(first.status).toBe("PENDING");
  expect(presignPut).toHaveBeenCalledWith(
    expect.objectContaining({
      contentType: "application/pdf",
      contentLength: 2048,
      createOnly: true,
    }),
  );

  const replaced = await replace(
    json({
      fileName: "Guide v2.pdf",
      mimeType: "application/pdf",
      sizeBytes: 4096,
    }),
    { params: Promise.resolve({ productId: "dp_1", assetId: "as_1" }) },
  );
  expect(replaced.status).toBe(201);
  expect(assetCreate.mock.calls[1][0].data).toMatchObject({
    lineageId: "lin_1",
    storageKey: expect.stringMatching(
      /^products\/dp_1\/lin_1\/[0-9a-f-]{36}\.pdf$/,
    ),
    version: 2,
    order: 3,
    status: "PENDING",
  });
});

it("deletes a product with only abandoned checkouts, and keeps one with a sale or a refund", async () => {
  purchases.push(
    { status: "PENDING", gatewayOrderId: "order_p", paymentId: null },
    { status: "FAILED", gatewayOrderId: "order_f", paymentId: null },
  );
  const deleted = await deleteProduct(json({}), params);
  expect(deleted.status).toBe(200);
  expect(purchaseDeleteMany).toHaveBeenCalledWith({
    where: {
      productId: "dp_1",
      status: { in: ["PENDING", "FAILED"] },
      paymentId: null,
    },
  });
  expect(productDelete).toHaveBeenCalledWith({ where: { id: "dp_1" } });
  // After commit, best effort; a late capture is refunded as an orphan.
  expect(cancelOrder.mock.calls.map(([id]) => id)).toEqual([
    "order_p",
    "order_f",
  ]);

  jest.clearAllMocks();
  purchases.push({
    status: "REFUNDED",
    gatewayOrderId: "order_r",
    paymentId: "pay_1",
  });
  const kept = await deleteProduct(json({}), params);
  expect(kept.status).toBe(409);
  expect((await kept.json()).code).toBe("HAS_PURCHASES");
  expect(productDelete).not.toHaveBeenCalled();
  expect(cancelOrder).not.toHaveBeenCalled();
});
