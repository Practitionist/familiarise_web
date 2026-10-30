/**
 * @jest-environment node
 */

/**
 * The two digital product sweeps: pending standalone purchases are settled
 * from Razorpay or failed after 24 hours, and the bucket is trimmed to what
 * the rows name.
 */
jest.mock("../../lib/cron/with-cron-lock", () => ({
  withCronLock: (_job: string, _opts: unknown, fn: () => unknown) => fn(),
  readJobCheckpoint: jest.fn(async () => "products/a/x/v1.pdf"),
}));
jest.mock("../../lib/observability/report", () => ({
  reportSentryError: jest.fn(),
}));
const holding = jest.fn();
jest.mock("../../lib/payments/core/razorpay", () => ({
  readRazorpayOrderHolding: (id: string) => holding(id),
  fetchRazorpayOrder: async (id: string) => ({
    id,
    notes: { type: "digital_product_purchase" },
  }),
}));
const route = jest.fn();
jest.mock("../../app/api/webhooks/razorpay-dispatch", () => ({
  routeCapturedPayment: (...a: unknown[]) => route(...a),
}));
const r2Delete = jest.fn(async (_opts: { key: string }) => ({ success: true }));
const r2List = jest.fn();
jest.mock("../../lib/storage/r2-client", () => ({
  deleteR2Object: (opts: { key: string }) => r2Delete(opts),
  listR2Keys: (...a: unknown[]) => r2List(...a),
}));

const HOUR = 60 * 60_000;
const ago = (ms: number) => new Date(Date.now() - ms);
const dpUpdate = jest.fn(async () => ({ count: 1 }));
const rpUpdate = jest.fn(async () => ({ count: 1 }));
const assetFindMany = jest.fn();
const assetUpdateMany = jest.fn(async () => ({ count: 1 }));
const assetDeleteMany = jest.fn(async () => ({ count: 1 }));
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    digitalProductPurchase: {
      findMany: async () => [
        { id: "dpp_cap", gatewayOrderId: "order_cap", createdAt: ago(HOUR) },
        {
          id: "dpp_old",
          gatewayOrderId: "order_old",
          createdAt: ago(30 * HOUR),
        },
        {
          id: "dpp_live",
          gatewayOrderId: "order_live",
          createdAt: ago(30 * HOUR),
        },
      ],
      updateMany: (...a: unknown[]) => dpUpdate(...(a as [])),
    },
    recordingPurchase: {
      findMany: async () => [
        { id: "rp_new", gatewayOrderId: "order_rp", createdAt: ago(HOUR) },
      ],
      updateMany: (...a: unknown[]) => rpUpdate(...(a as [])),
    },
    digitalProductAsset: {
      findMany: (...a: unknown[]) => assetFindMany(...a),
      updateMany: (...a: unknown[]) => assetUpdateMany(...(a as [])),
      deleteMany: (...a: unknown[]) => assetDeleteMany(...(a as [])),
    },
  },
}));

import { reconcileStandalonePurchases } from "../../scripts/payments/reconcile-standalone-purchases";
import { reconcileDigitalProductStorage } from "../../lib/digital-products/storage-sweep";

beforeEach(() => {
  jest.clearAllMocks();
  process.env.R2_DIGITAL_PRODUCTS_BUCKET = "digital-products";
});

it("routes captured orders, fails empty ones after 24 hours and leaves live ones pending", async () => {
  holding.mockImplementation(async (id: string) =>
    id === "order_cap"
      ? { kind: "captured", paymentId: "pay_1", amountPaise: 59_000 }
      : id === "order_live"
        ? { kind: "live" }
        : { kind: "empty" },
  );
  const result = await reconcileStandalonePurchases({ limit: 5 });
  expect(result).toMatchObject({
    scanned: 4,
    recovered: 1,
    expired: 1,
    errors: 0,
  });
  expect(route).toHaveBeenCalledWith({
    orderId: "order_cap",
    notes: { type: "digital_product_purchase" },
    amountPaise: 59_000,
    gatewayPaymentId: "pay_1",
  });
  expect(dpUpdate).toHaveBeenCalledWith({
    where: { id: "dpp_old", status: "PENDING" },
    data: { status: "FAILED" },
  });
  expect(dpUpdate).toHaveBeenCalledWith({
    where: { id: "dpp_live", status: "PENDING" },
    data: { updatedAt: expect.any(Date) },
  });
  // A young empty replay order is only touched so it rotates.
  expect(rpUpdate).toHaveBeenCalledWith({
    where: { id: "rp_new", status: "PENDING" },
    data: { updatedAt: expect.any(Date) },
  });
});

it("purges old versions, clears dead uploads and deletes only unnamed old objects", async () => {
  assetFindMany
    .mockResolvedValueOnce([{ id: "a_sup", storageKey: "products/p/a/v1.pdf" }])
    .mockResolvedValueOnce([
      { id: "a_rej", storageKey: "products/p/b/v1.zip", status: "REJECTED" },
    ])
    .mockResolvedValueOnce([{ storageKey: "products/p/c/v1.pdf" }]);
  r2List.mockResolvedValueOnce({
    keys: [
      "products/p/c/v1.pdf",
      "products/p/orphan/v1.pdf",
      "products/p/new/v1.pdf",
    ],
    truncated: true,
    objects: [
      { key: "products/p/c/v1.pdf", lastModified: ago(48 * HOUR) },
      { key: "products/p/orphan/v1.pdf", lastModified: ago(48 * HOUR) },
      { key: "products/p/new/v1.pdf", lastModified: ago(HOUR) },
    ],
  });
  const result = await reconcileDigitalProductStorage({ limit: 25 });
  expect(result).toMatchObject({
    supersededPurged: 1,
    uploadsCleared: 1,
    orphansDeleted: 1,
    failed: 0,
    checkpoint: "products/p/new/v1.pdf",
  });
  expect(r2List).toHaveBeenCalledWith(
    expect.objectContaining({ startAfter: "products/a/x/v1.pdf" }),
  );
  expect(r2Delete.mock.calls.map(([o]) => o.key)).toEqual([
    "products/p/a/v1.pdf",
    "products/p/b/v1.zip",
    "products/p/orphan/v1.pdf",
  ]);
  expect(assetUpdateMany).toHaveBeenCalledWith({
    where: { id: { in: ["a_sup"] }, status: "SUPERSEDED", purgedAt: null },
    data: { purgedAt: expect.any(Date) },
  });
  expect(assetDeleteMany).toHaveBeenCalledWith({
    where: { id: "a_rej", status: "REJECTED" },
  });
});
