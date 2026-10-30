/**
 * @jest-environment node
 */

/**
 * The two digital product sweeps: pending (and recently failed) standalone
 * purchases are settled from Razorpay or failed after 24 hours, rotating by
 * their last check, and the bucket is trimmed to what the rows name, retiring
 * an abandoned upload before its object is deleted.
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
const dpUpdate = jest.fn(async (_args: unknown) => ({ count: 1 }));
const dpFindMany = jest.fn();
const rpUpdate = jest.fn(async () => ({ count: 1 }));
const assetFindMany = jest.fn();
const assetUpdateMany = jest.fn(async () => ({ count: 1 }));
const assetDeleteMany = jest.fn(async () => ({ count: 1 }));
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    digitalProductPurchase: {
      findMany: (...a: unknown[]) => dpFindMany(...a),
      updateMany: (args: unknown) => dpUpdate(args),
    },
    recordingPurchase: {
      findMany: async () => [
        {
          id: "rp_new",
          gatewayOrderId: "order_rp",
          status: "PENDING",
          createdAt: ago(HOUR),
        },
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
  dpFindMany.mockResolvedValue([
    {
      id: "dpp_cap",
      gatewayOrderId: "order_cap",
      status: "PENDING",
      createdAt: ago(HOUR),
    },
    {
      id: "dpp_old",
      gatewayOrderId: "order_old",
      status: "PENDING",
      createdAt: ago(30 * HOUR),
    },
    {
      id: "dpp_live",
      gatewayOrderId: "order_live",
      status: "PENDING",
      createdAt: ago(30 * HOUR),
    },
  ]);
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
    data: { status: "FAILED", reconciledAt: expect.any(Date) },
  });
  expect(dpUpdate).toHaveBeenCalledWith({
    where: { id: "dpp_live", status: "PENDING" },
    data: { reconciledAt: expect.any(Date) },
  });
  // A young empty replay order is only stamped so it rotates.
  expect(rpUpdate).toHaveBeenCalledWith({
    where: { id: "rp_new", status: "PENDING" },
    data: { reconciledAt: expect.any(Date) },
  });
  // FAILED rows inside the recovery window are read too; REFUNDED never is.
  const [{ where, orderBy }] = dpFindMany.mock.calls[0] as [
    { where: { OR: { status: string }[] }; orderBy: unknown[] },
  ];
  expect(where.OR.map((o) => o.status)).toEqual(["PENDING", "FAILED"]);
  expect(orderBy[0]).toEqual({
    reconciledAt: { sort: "asc", nulls: "first" },
  });
});

it("rotates a full page of failing gateway reads so a captured order behind it settles", async () => {
  interface Row {
    id: string;
    gatewayOrderId: string;
    status: string;
    createdAt: Date;
    reconciledAt: Date | null;
  }
  const store: Row[] = [
    ...Array.from({ length: 5 }, (_, i) => ({
      id: `dpp_bad${i}`,
      gatewayOrderId: `order_bad${i}`,
      status: "PENDING",
      createdAt: ago(3 * HOUR + i),
      reconciledAt: null,
    })),
    {
      id: "dpp_good",
      gatewayOrderId: "order_good",
      status: "PENDING",
      createdAt: ago(2 * HOUR),
      reconciledAt: null,
    },
  ];
  const created = new Map(store.map((r) => [r.id, r.createdAt]));
  dpFindMany.mockImplementation(async ({ take }: { take: number }) =>
    store
      .filter((r) => r.status === "PENDING")
      .sort(
        (a, b) =>
          (a.reconciledAt?.getTime() ?? -1) -
            (b.reconciledAt?.getTime() ?? -1) ||
          a.createdAt.getTime() - b.createdAt.getTime(),
      )
      .slice(0, take),
  );
  dpUpdate.mockImplementation(async (args: unknown) => {
    const { where, data } = args as {
      where: { id: string; status: string };
      data: Partial<Row>;
    };
    const row = store.find(
      (r) => r.id === where.id && r.status === where.status,
    );
    if (row) Object.assign(row, data);
    return { count: row ? 1 : 0 };
  });
  holding.mockImplementation(async (id: string) => {
    if (id.startsWith("order_bad")) throw new Error("gateway 500");
    return id === "order_good"
      ? { kind: "captured", paymentId: "pay_g", amountPaise: 59_000 }
      : { kind: "empty" };
  });
  route.mockImplementation(async ({ orderId }: { orderId: string }) => {
    const row = store.find((r) => r.gatewayOrderId === orderId);
    if (row) row.status = "SUCCEEDED";
  });

  const first = await reconcileStandalonePurchases({ limit: 5 });
  expect(first.errors).toBe(5);
  expect(store.slice(0, 5).every((r) => r.reconciledAt)).toBe(true);
  const second = await reconcileStandalonePurchases({ limit: 5 });
  expect(second.recovered).toBe(1);
  expect(store.find((r) => r.id === "dpp_good")?.status).toBe("SUCCEEDED");
  // The failures keep their order, status and expiry clock.
  for (const row of store.slice(0, 5)) {
    expect(row).toMatchObject({
      status: "PENDING",
      gatewayOrderId: row.id.replace("dpp_", "order_"),
    });
    expect(row.createdAt).toBe(created.get(row.id));
  }
});

it("purges old versions, retires a dead upload before deleting it and deletes only unnamed old objects", async () => {
  assetFindMany
    .mockResolvedValueOnce([{ id: "a_sup", storageKey: "products/p/a/v1.pdf" }])
    .mockResolvedValueOnce([
      { id: "a_rej", storageKey: "products/p/b/v1.zip", status: "REJECTED" },
      { id: "a_pend", storageKey: "products/p/d/v1.pdf", status: "PENDING" },
    ])
    // A commit verified a_pend before the retire CAS, so only a_rej is retired.
    .mockResolvedValueOnce([{ id: "a_rej", storageKey: "products/p/b/v1.zip" }])
    .mockResolvedValueOnce([{ storageKey: "products/p/c/v1.pdf" }]);
  assetUpdateMany
    .mockResolvedValueOnce({ count: 1 })
    .mockResolvedValueOnce({ count: 0 });
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
  expect(assetUpdateMany).toHaveBeenCalledWith({
    where: { id: { in: ["a_pend"] }, status: "PENDING" },
    data: { status: "REJECTED", rejectReason: "ABANDONED" },
  });
  expect(assetDeleteMany).toHaveBeenCalledWith({
    where: { id: { in: ["a_rej"] }, status: "REJECTED" },
  });
});
