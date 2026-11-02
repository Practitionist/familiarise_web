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
jest.mock("../../lib/digital-products/purchase-email", () => ({
  stageOwedDigitalProductReceipts: async () => ({
    checked: 0,
    handled: 0,
    failedIds: [],
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
type Where = { status: string };
const ago = (ms: number) => new Date(Date.now() - ms);
const dpUpdate = jest.fn(async (_args: unknown) => ({ count: 1 }));
const dpFindMany = jest.fn();
const dpFindUnique = jest.fn();
const rpUpdate = jest.fn(async () => ({ count: 1 }));
const assetFindMany = jest.fn();
const assetQueryRaw = jest.fn(async (..._a: unknown[]) => []);
const assetUpdateMany = jest.fn(async () => ({ count: 1 }));
const assetDeleteMany = jest.fn(async () => ({ count: 1 }));
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    digitalProductPurchase: {
      findMany: (...a: unknown[]) => dpFindMany(...a),
      findUnique: (...a: unknown[]) => dpFindUnique(...a),
      updateMany: (args: unknown) => dpUpdate(args),
    },
    recordingPurchase: {
      findMany: async ({ where }: { where: { status: string } }) =>
        where.status === "PENDING"
          ? [
              {
                id: "rp_new",
                gatewayOrderId: "order_rp",
                status: "PENDING",
                createdAt: ago(HOUR),
              },
            ]
          : [],
      findUnique: async () => ({ status: "PENDING" }),
      updateMany: (...a: unknown[]) => rpUpdate(...(a as [])),
    },
    $queryRaw: (...a: unknown[]) => assetQueryRaw(...a),
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
  dpFindUnique.mockResolvedValue({ status: "SUCCEEDED" });
  const pending = [
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
  ];
  dpFindMany.mockImplementation(async ({ where }: { where: Where }) =>
    where.status === "PENDING" ? pending : [],
  );
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
  // PENDING and FAILED (inside the recovery window) each get a slice; REFUNDED is never read.
  const calls = dpFindMany.mock.calls.map(
    ([a]) => a as { where: Where; take: number; orderBy: unknown[] },
  );
  expect(calls.map((c) => [c.where.status, c.take])).toEqual([
    ["PENDING", 5],
    ["FAILED", 2],
  ]);
  expect(calls[0].orderBy[0]).toEqual({
    reconciledAt: { sort: "asc", nulls: "first" },
  });
});

interface Row {
  id: string;
  gatewayOrderId: string;
  status: string;
  createdAt: Date;
  reconciledAt: Date | null;
}

/** Back the digital rail with rows that honour status, rotation order, take and CAS. */
function useStore(store: Row[]) {
  dpFindMany.mockImplementation(
    async ({ where, take }: { where: Where; take: number }) =>
      store
        .filter((r) => r.status === where.status)
        .sort(
          (a, b) =>
            (a.reconciledAt?.getTime() ?? -1) -
              (b.reconciledAt?.getTime() ?? -1) ||
            a.createdAt.getTime() - b.createdAt.getTime(),
        )
        .slice(0, take),
  );
  dpFindUnique.mockImplementation(
    async ({ where }: { where: { id: string } }) =>
      store.find((r) => r.id === where.id),
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
}

it("rotates a full page of failing gateway reads so a captured order behind it settles", async () => {
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
  useStore(store);
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

it("never lets a page of dead FAILED rows block a PENDING capture, and counts only settled ones", async () => {
  // Captured but refunded by the handler, so each re-route leaves the row FAILED.
  const store: Row[] = [
    ...Array.from({ length: 5 }, (_, i) => ({
      id: `dpp_dead${i}`,
      gatewayOrderId: `order_dead${i}`,
      status: "FAILED",
      createdAt: ago(48 * HOUR + i),
      reconciledAt: null,
    })),
    {
      id: "dpp_cap",
      gatewayOrderId: "order_cap",
      status: "PENDING",
      createdAt: ago(HOUR),
      reconciledAt: ago(HOUR / 4),
    },
  ];
  useStore(store);
  holding.mockResolvedValue({
    kind: "captured",
    paymentId: "pay_x",
    amountPaise: 59_000,
  });
  route.mockImplementation(async ({ orderId }: { orderId: string }) => {
    if (orderId === "order_cap") store[5].status = "SUCCEEDED";
  });

  const result = await reconcileStandalonePurchases({ limit: 5 });
  expect(store[5].status).toBe("SUCCEEDED");
  // The PENDING capture, two FAILED re-routes and the replay row (which stays PENDING).
  expect(route).toHaveBeenCalledTimes(4);
  expect(result).toMatchObject({ scanned: 4, recovered: 1, errors: 0 });
});

it("purges old versions, retires a dead upload before deleting it and deletes only unnamed old objects", async () => {
  assetQueryRaw.mockResolvedValueOnce([
    { id: "a_sup", storageKey: "products/p/a/v1.pdf" },
  ]);
  assetFindMany
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
  // Superseded over 30 days ago, or behind its lineage's two newest versions.
  const purgeSql = (assetQueryRaw.mock.calls[0][0] as string[]).join("?");
  expect(purgeSql).toMatch(/"supersededAt" < \?/);
  expect(purgeSql).toMatch(/b\.version > a\.version[\s\S]*OFFSET 1/);
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
