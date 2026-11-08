/**
 * @jest-environment node
 */

/**
 * The buyer doors: overlapping purchase POSTs mint one order (the second
 * resumes it) at the amount the page quotes, a free claim stages its receipt
 * in its transaction, a second one or one with nothing deliverable is
 * refused, and a download locks the
 * live purchase in its transaction, refusing one a refund revoked first.
 */

// Priced and invoiced as a GST-registered platform (Haryana, the registered office).
process.env.PLATFORM_GSTIN = "06AAFCF1234Q1ZN";

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
const stageReceipt = jest.fn(async (_tx: unknown, _receipt: unknown) => [
  { staged: { id: "fe_1" } },
]);
const flushReceipt = jest.fn();
jest.mock("../../lib/digital-products/purchase-email", () => ({
  prepareDigitalProductReceipt: async (input: { purchaseId: string }) => ({
    purchaseId: input.purchaseId,
  }),
  stageDigitalProductReceipt: (tx: unknown, receipt: unknown) =>
    stageReceipt(tx, receipt),
  flushDigitalProductReceipt: (...a: unknown[]) => flushReceipt(...a),
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
const lockPurchase = jest.fn();
const asset = (version: number, status: string) => ({
  id: `as_${version}`,
  lineageId: "lin_1",
  version,
  status,
  storageKey: `products/dp_1/lin_1/as_${version}.pdf`,
  originalName: version === 1 ? "Guide.pdf" : `Guide v${version}.pdf`,
  mimeType: "application/pdf",
  product: { consultantProfileId: "cp_owner", takenDownAt: null },
});
const assetFindFirst = jest.fn();
const purchaseModel = {
  findFirst: async ({ where }: { where: Partial<Row> }) =>
    rows.find(
      (r) =>
        r.productId === where.productId &&
        r.buyerId === where.buyerId &&
        r.status === where.status,
    ) ?? null,
  create: async ({ data }: { data: Row | Omit<Row, "id"> }) => {
    const row = { id: `dpp_${rows.length + 1}`, ...data };
    rows.push(row);
    return row;
  },
};
const deliverable = { ok: true };
const tx = {
  $queryRaw: (...a: unknown[]) => lockPurchase(...a),
  $executeRaw: async () => 1,
  digitalProduct: {
    findFirst: async () => (deliverable.ok ? { id: "dp_1" } : null),
  },
  digitalProductPurchase: { ...purchaseModel, updateMany: stamp },
  digitalProductDownload: { create: downloadCreate },
};
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    user: { findUnique: async () => ({ country: "IN" }) },
    digitalProduct: {
      findUnique: async () => ({ ...product, slug: "guide-1" }),
    },
    digitalProductAsset: {
      findFirst: (...a: unknown[]) => assetFindFirst(...a),
      findMany: async () => [{ lineageId: "lin_1", originalName: "Guide.pdf" }],
    },
    get digitalProductPurchase() {
      return purchaseModel;
    },
    $transaction: (cb: (t: typeof tx) => Promise<unknown>) => cb(tx),
  },
}));

import { requireApiAuth } from "../../lib/auth-helpers";
import { POST as purchase } from "../../app/api/digital-products/[productId]/purchase/route";
import { POST as claim } from "../../app/api/digital-products/[productId]/claim/route";
import { GET as download } from "../../app/api/digital-products/[productId]/assets/[assetId]/download/route";
import { quoteDigitalProductForBuyer } from "../../lib/payments/pricing/digital-product-price";
import { attachmentDisposition } from "../../lib/digital-products/storage";

const params = { params: Promise.resolve({ productId: "dp_1" }) };
const req = () => new Request("http://localhost/x", { method: "POST" });

beforeEach(() => {
  jest.clearAllMocks();
  rows.length = 0;
  mintCount = 0;
  deliverable.ok = true;
  product.pricePaise = 50_000;
  assetFindFirst.mockResolvedValue(asset(1, "VERIFIED"));
  process.env.R2_DIGITAL_PRODUCTS_BUCKET = "digital-products";
});

it("mints one order at the quoted amount for overlapping purchases and refuses a second free claim", async () => {
  const quote = await quoteDigitalProductForBuyer({
    productId: "dp_1",
    pricePaise: 50_000,
    buyerId: "buyer_1",
  });
  expect(quote).toEqual({
    basePaise: 50_000,
    taxPaise: 9_000,
    totalPaise: 59_000,
  });
  const [a, b] = await Promise.all([
    purchase(req(), params),
    purchase(req(), params),
  ]);
  expect(createRazorpayOrder).toHaveBeenCalledTimes(1);
  expect(createRazorpayOrder.mock.calls[0]).toEqual([
    expect.objectContaining({ amount: quote.totalPaise }),
  ]);
  // A resumed order is shown at its persisted amount.
  rows[0].amountPaise = 61_000;
  expect(
    await quoteDigitalProductForBuyer({
      productId: "dp_1",
      pricePaise: 50_000,
      buyerId: "buyer_1",
    }),
  ).toEqual({ basePaise: null, taxPaise: null, totalPaise: 61_000 });
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
  // The receipt is staged on the claim's own transaction, then flushed after commit.
  expect(stageReceipt).toHaveBeenCalledTimes(1);
  expect(stageReceipt).toHaveBeenCalledWith(tx, { purchaseId: rows[0].id });
  expect(flushReceipt).toHaveBeenCalledWith(
    [{ staged: { id: "fe_1" } }],
    expect.any(Number),
  );

  // Nothing deliverable under the product lock: refused, and no claim row.
  rows.length = 0;
  deliverable.ok = false;
  const empty = await claim(req(), params);
  expect(empty.status).toBe(409);
  expect((await empty.json()).code).toBe("NO_DELIVERABLE");
  expect(rows).toHaveLength(0);
});

it("answers the owner's own purchase and claim with OWN_PRODUCT and the owner copy", async () => {
  const asOwner = {
    session: {
      user: { id: "owner_1", consultantProfileId: "cp_owner", role: "USER" },
    },
  } as Awaited<ReturnType<typeof requireApiAuth>>;
  jest.mocked(requireApiAuth).mockResolvedValueOnce(asOwner);
  const bought = await purchase(req(), params);
  expect(bought.status).toBe(400);
  expect(await bought.json()).toEqual({
    code: "OWN_PRODUCT",
    error: "This is your own product — buyers will see a Buy button here.",
  });
  product.pricePaise = 0;
  jest.mocked(requireApiAuth).mockResolvedValueOnce(asOwner);
  const claimed = await claim(req(), params);
  expect(claimed.status).toBe(400);
  expect((await claimed.json()).code).toBe("OWN_PRODUCT");
  expect(createRazorpayOrder).not.toHaveBeenCalled();
  expect(rows).toHaveLength(0);
});

const downloadOnce = () =>
  download(new Request("http://localhost/x"), {
    params: Promise.resolve({ productId: "dp_1", assetId: "as_1" }),
  });

it("locks the live purchase in the download transaction: revoked first, download first, repeat", async () => {
  // A refund committed first: no SUCCEEDED row to lock, no URL, no download row.
  lockPurchase.mockResolvedValueOnce([]);
  const revoked = await downloadOnce();
  expect(revoked.status).toBe(403);
  expect(downloadCreate).not.toHaveBeenCalled();
  expect(presign).not.toHaveBeenCalled();
  const [sql, ...values] = lockPurchase.mock.calls[0] as [
    TemplateStringsArray,
    ...unknown[],
  ];
  expect(sql.join("?")).toMatch(/status = 'SUCCEEDED'\s+FOR UPDATE/);
  expect(values).toEqual(["dp_1", "buyer_1"]);

  // The download commits first; a later refund waits on the lock.
  lockPurchase.mockResolvedValue([{ id: "dpp_9" }]);
  const res = await downloadOnce();
  expect(res.status).toBe(302);
  expect(res.headers.get("location")).toBe("https://r2/signed");
  expect(stamp).toHaveBeenCalledWith({
    where: { id: "dpp_9", status: "SUCCEEDED", firstDownloadedAt: null },
    data: { firstDownloadedAt: expect.any(Date) },
  });
  expect(presign).toHaveBeenCalledWith(
    expect.objectContaining({
      bucket: "digital-products",
      expiresInSeconds: 300,
      responseContentDisposition: expect.stringMatching(/^attachment;/),
    }),
  );

  // A repeat download is served and recorded; the stamp CAS changes nothing.
  stamp.mockResolvedValueOnce({ count: 0 });
  expect((await downloadOnce()).status).toBe(302);
  expect(downloadCreate).toHaveBeenCalledTimes(2);
  expect(downloadCreate).toHaveBeenLastCalledWith({
    data: { purchaseId: "dpp_9", assetId: "as_1" },
  });
});

it("encodes a download name to RFC 8187 attr-char with a quoted ASCII fallback", () => {
  expect(attachmentDisposition("Léa's guide (v2)*.pdf")).toBe(
    `attachment; filename="L_a's guide (v2)*.pdf"; filename*=UTF-8''L%C3%A9a%27s%20guide%20%28v2%29%2A.pdf`,
  );
});

it("serves a stale link the current version under the first name, and sends a browser from a removed file to the product page", async () => {
  rows.push({
    id: "dpp_1",
    productId: "dp_1",
    buyerId: "buyer_1",
    amountPaise: 0,
    status: "SUCCEEDED",
  });
  lockPurchase.mockResolvedValue([{ id: "dpp_1" }]);
  assetFindFirst
    .mockResolvedValueOnce(asset(1, "SUPERSEDED"))
    .mockResolvedValueOnce(asset(3, "VERIFIED"));
  const res = await downloadOnce();
  expect(res.status).toBe(302);
  expect(downloadCreate).toHaveBeenCalledWith({
    data: { purchaseId: "dpp_1", assetId: "as_3" },
  });
  expect(presign.mock.calls[0][0]).toMatchObject({
    key: "products/dp_1/lin_1/as_3.pdf",
    responseContentDisposition: expect.stringContaining('filename="Guide.pdf"'),
  });
  // A replacement in another format keeps the first stem under its own extension.
  assetFindFirst.mockResolvedValueOnce({
    ...asset(4, "VERIFIED"),
    originalName: "Guide final.docx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  });
  await downloadOnce();
  expect(presign.mock.calls[1][0].responseContentDisposition).toContain(
    'filename="Guide.docx"',
  );

  // The lineage has no current version: removed.
  assetFindFirst
    .mockResolvedValueOnce(asset(3, "SUPERSEDED"))
    .mockResolvedValueOnce(null);
  const api = await downloadOnce();
  expect(api.status).toBe(410);
  expect((await api.json()).code).toBe("FILE_REMOVED");
  assetFindFirst
    .mockResolvedValueOnce(asset(3, "SUPERSEDED"))
    .mockResolvedValueOnce(null);
  const browser = await download(
    new Request("http://localhost/x", { headers: { accept: "text/html" } }),
    { params: Promise.resolve({ productId: "dp_1", assetId: "as_3" }) },
  );
  expect(browser.status).toBe(303);
  expect(browser.headers.get("location")).toBe(
    "http://localhost/explore/products/guide-1?notice=file-removed",
  );
});
