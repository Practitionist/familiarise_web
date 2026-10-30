/**
 * @jest-environment node
 */

/**
 * The buyer doors: overlapping purchase POSTs mint one order (the second
 * resumes it), a second free claim is refused, and a download stamps the
 * refund-window end by CAS before redirecting to a 300 s attachment URL.
 */

jest.mock("@sentry/nextjs", () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
  logger: { info: jest.fn(), fmt: (s: TemplateStringsArray) => s.join("") },
}));
jest.mock("../../lib/redis", () => {
  const held = new Map<string, string>();
  return {
    __esModule: true,
    __held: held,
    default: {
      set: async (key: string, value: string, opts?: { nx?: boolean }) => {
        if (opts?.nx && held.has(key)) return null;
        held.set(key, value);
        return "OK";
      },
      eval: async (_script: string, keys: string[], args: string[]) => {
        if (held.get(keys[0]) === args[0]) {
          held.delete(keys[0]);
          return 1;
        }
        return 0;
      },
    },
    withCircuitBreaker: (fn: () => unknown) => fn(),
    checkRedisHealth: async () => true,
  };
});
jest.mock("../../lib/auth-helpers", () => ({
  requireApiAuth: jest.fn(async () => ({
    session: {
      user: { id: "buyer_1", consultantProfileId: null, role: "USER" },
    },
  })),
  isPrivileged: () => false,
}));
jest.mock("../../lib/rate-limit", () => ({
  applyRateLimit: async () => null,
  checkoutLimiter: {},
  digitalProductDownloadLimiter: {},
}));
const notifyPurchase = jest.fn();
jest.mock("../../lib/digital-products/purchase-email", () => ({
  notifyDigitalProductPurchase: (...a: unknown[]) => notifyPurchase(...a),
}));
jest.mock("../../lib/payments/core/saved-card-customer", () => ({
  savedCardCustomerId: async () => undefined,
}));
let mintCount = 0;
const createRazorpayOrder = jest.fn(async () => {
  mintCount += 1;
  await new Promise((r) => setTimeout(r, 20));
  return { id: `order_${mintCount}`, amount: 59_000, currency: "INR" };
});
jest.mock("../../lib/payments/core/razorpay", () => ({
  createRazorpayOrder: (...a: unknown[]) => createRazorpayOrder(...(a as [])),
  cancelRazorpayOrder: jest.fn(),
}));
const presign = jest.fn(
  (_opts: Record<string, unknown>) => "https://r2/signed",
);
jest.mock("../../lib/storage/r2-client", () => ({
  createR2PresignedGetUrl: (opts: Record<string, unknown>) => presign(opts),
}));

interface Row {
  id: string;
  productId: string;
  buyerId: string;
  gatewayOrderId?: string;
  amountPaise: number;
  status: string;
}
const rows: Row[] = [];
const stamp = jest.fn(async () => ({ count: 1 }));
const downloadCreate = jest.fn(async () => ({}));
const product = {
  id: "dp_1",
  consultantProfileId: "cp_owner",
  organizationId: null,
  visibility: "PUBLIC",
  status: "PUBLISHED",
  takenDownAt: null,
  pricePaise: 50_000,
};
const tx = {
  digitalProductPurchase: { updateMany: stamp },
  digitalProductDownload: { create: downloadCreate },
};
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    user: { findUnique: async () => ({ country: "IN" }) },
    digitalProduct: { findUnique: async () => product },
    digitalProductAsset: {
      findFirst: async () => ({
        id: "as_1",
        storageKey: "products/dp_1/as_1/v1.pdf",
        originalName: "Guide.pdf",
        product: { consultantProfileId: "cp_owner", takenDownAt: null },
      }),
    },
    digitalProductPurchase: {
      findFirst: async ({ where }: { where: Partial<Row> }) =>
        rows.find(
          (r) =>
            r.productId === where.productId &&
            r.buyerId === where.buyerId &&
            r.status === where.status,
        ) ?? null,
      create: async ({ data }: { data: Omit<Row, "id"> }) => {
        const row = { id: `dpp_${rows.length + 1}`, ...data };
        rows.push(row);
        return row;
      },
    },
    $transaction: (cb: (t: typeof tx) => Promise<unknown>) => cb(tx),
  },
}));

import { POST as purchase } from "../../app/api/digital-products/[productId]/purchase/route";
import { POST as claim } from "../../app/api/digital-products/[productId]/claim/route";
import { GET as download } from "../../app/api/digital-products/[productId]/assets/[assetId]/download/route";

const params = { params: Promise.resolve({ productId: "dp_1" }) };
const req = () => new Request("http://localhost/x", { method: "POST" });

beforeEach(() => {
  jest.clearAllMocks();
  rows.length = 0;
  mintCount = 0;
  product.pricePaise = 50_000;
  process.env.R2_DIGITAL_PRODUCTS_BUCKET = "digital-products";
});

it("mints one order for overlapping purchases and refuses a second free claim", async () => {
  const [a, b] = await Promise.all([
    purchase(req(), params),
    purchase(req(), params),
  ]);
  expect(createRazorpayOrder).toHaveBeenCalledTimes(1);
  expect(rows).toHaveLength(1);
  expect([a.status, b.status].sort()).toEqual([200, 201]);
  expect(createRazorpayOrder.mock.calls[0]).toEqual([
    expect.objectContaining({
      amount: 59_000,
      metadata: expect.objectContaining({
        type: "digital_product_purchase",
        originalAmountPaise: "50000",
        taxAmountPaise: "9000",
      }),
    }),
  ]);

  rows.length = 0;
  product.pricePaise = 0;
  expect((await claim(req(), params)).status).toBe(201);
  expect(rows[0]).toMatchObject({ amountPaise: 0, status: "SUCCEEDED" });
  expect(rows[0].gatewayOrderId).toBeUndefined();
  const again = await claim(req(), params);
  expect(again.status).toBe(400);
  expect((await again.json()).code).toBe("ALREADY_ENTITLED");
  expect(notifyPurchase).toHaveBeenCalledTimes(1);
  expect(notifyPurchase).toHaveBeenCalledWith(
    { id: rows[0].id },
    expect.any(Number),
  );
});

it("stamps the first download by CAS and redirects to a 300 s attachment URL", async () => {
  rows.push({
    id: "dpp_9",
    productId: "dp_1",
    buyerId: "buyer_1",
    amountPaise: 59_000,
    status: "SUCCEEDED",
  });
  const res = await download(new Request("http://localhost/x"), {
    params: Promise.resolve({ productId: "dp_1", assetId: "as_1" }),
  });
  expect(res.status).toBe(302);
  expect(res.headers.get("location")).toBe("https://r2/signed");
  expect(stamp).toHaveBeenCalledWith({
    where: { id: "dpp_9", status: "SUCCEEDED", firstDownloadedAt: null },
    data: { firstDownloadedAt: expect.any(Date) },
  });
  expect(downloadCreate).toHaveBeenCalledWith({
    data: { purchaseId: "dpp_9", assetId: "as_1" },
  });
  expect(presign).toHaveBeenCalledWith(
    expect.objectContaining({
      bucket: "digital-products",
      expiresInSeconds: 300,
      responseContentDisposition: expect.stringMatching(/^attachment;/),
    }),
  );
});
