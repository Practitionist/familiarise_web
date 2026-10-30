/**
 * @jest-environment node
 */

/**
 * A product file is written once and inspected as one object version: the
 * PUT is signed create-only, every inspection read is ETag-fenced, versions
 * are allocated per lineage under the product row lock, an older version never
 * becomes current after a newer one, and the caps hold under concurrency.
 */
jest.mock("../../lib/auth-helpers", () => ({
  requireApiAuth: async () => ({
    session: { user: { id: "u_1", consultantProfileId: "cp_1" } },
  }),
}));

interface Asset {
  id: string;
  productId: string;
  lineageId: string;
  storageKey: string;
  mimeType: string;
  sizeBytes: number;
  order: number;
  version: number;
  status: string;
  rejectReason?: string;
}
const mockAssets: Asset[] = [];
const mockLocks: string[] = [];
const mockProduct = {
  id: "dp_1",
  consultantProfileId: "cp_1",
  slug: "guide-1",
  status: "DRAFT",
  category: "TEMPLATE",
  takenDownAt: null,
};

type Where = Record<string, unknown>;
function mockMatches(row: Asset, where: Where): boolean {
  return Object.entries(where).every(([key, cond]) => {
    const value = row[key as keyof Asset];
    if (cond && typeof cond === "object") {
      const c = cond as {
        in?: unknown[];
        not?: unknown;
        gt?: number;
        lt?: number;
      };
      if (c.in) return c.in.includes(value);
      if (c.not !== undefined) return value !== c.not;
      if (c.gt !== undefined) return Number(value) > c.gt;
      if (c.lt !== undefined) return Number(value) < c.lt;
    }
    return value === cond;
  });
}

jest.mock("../../lib/prisma", () => {
  const asset = {
    findMany: async ({ where }: { where: Where }) =>
      mockAssets.filter((a) => mockMatches(a, where)),
    findFirst: async ({
      where,
      orderBy,
    }: {
      where: Where;
      orderBy?: { order: "desc" };
    }) => {
      const hits = mockAssets.filter((a) => mockMatches(a, where));
      if (orderBy) hits.sort((a, b) => b.order - a.order);
      return hits[0] ?? null;
    },
    aggregate: async ({ where }: { where: Where }) => ({
      _max: {
        version:
          Math.max(
            0,
            ...mockAssets
              .filter((a) => mockMatches(a, where))
              .map((a) => a.version),
          ) || null,
      },
    }),
    create: async ({ data }: { data: Asset }) => {
      // Mirrors the (lineageId, version) unique.
      if (
        mockAssets.some(
          (a) => a.lineageId === data.lineageId && a.version === data.version,
        )
      ) {
        throw new Error("P2002");
      }
      mockAssets.push({ ...data });
      return data;
    },
    updateMany: async ({
      where,
      data,
    }: {
      where: Where;
      data: Partial<Asset>;
    }) => {
      const hits = mockAssets.filter((a) => mockMatches(a, where));
      for (const hit of hits) Object.assign(hit, data);
      return { count: hits.length };
    },
    count: async ({ where }: { where: Where }) =>
      mockAssets.filter((a) => mockMatches(a, where)).length,
    deleteMany: async ({ where }: { where: Where }) => {
      const kept = mockAssets.filter((a) => !mockMatches(a, where));
      const count = mockAssets.length - kept.length;
      mockAssets.splice(0, mockAssets.length, ...kept);
      return { count };
    },
  };
  const digitalProduct = {
    findFirst: async () => mockProduct,
    findUnique: async () => mockProduct,
  };
  let queue: Promise<unknown> = Promise.resolve();
  const tx = {
    digitalProductAsset: asset,
    digitalProduct,
    // Unsold, so removing a draft's last file is allowed.
    digitalProductPurchase: { findFirst: async () => null },
    $executeRaw: async (sql: TemplateStringsArray, id: string) => {
      mockLocks.push(`${sql.join("?")}|${id}`);
      return 1;
    },
  };
  return {
    __esModule: true,
    default: {
      digitalProductAsset: asset,
      digitalProduct,
      // One product row lock: transactions on it run one after another.
      $transaction: (cb: (t: typeof tx) => Promise<unknown>) => {
        const run = queue.then(() => cb(tx));
        queue = run.catch(() => undefined);
        return run;
      },
    },
  };
});

import { reservePendingAsset } from "../../lib/digital-products/creator";
import { verifyDigitalProductAsset } from "../../lib/digital-products/verify-asset";
import { createR2PresignedPutUrl } from "../../lib/storage/r2-client";
import { DELETE as removeFile } from "../../app/api/digital-products/[productId]/assets/[assetId]/route";

const product = {
  id: "dp_1",
  consultantProfileId: "cp_1",
  slug: "guide-1",
  status: "DRAFT" as const,
  category: "TEMPLATE" as const,
  takenDownAt: null,
};
const MB = 1024 * 1024;
const fetchMock = jest.fn();

beforeEach(() => {
  mockProduct.category = "TEMPLATE";
  mockAssets.length = 0;
  mockLocks.length = 0;
  fetchMock.mockReset();
  global.fetch = fetchMock;
  Object.assign(process.env, {
    R2_S3_ENDPOINT: "https://acct.r2.cloudflarestorage.com",
    R2_ACCESS_KEY_ID: "key",
    R2_SECRET_ACCESS_KEY: "secret",
    R2_DIGITAL_PRODUCTS_BUCKET: "digital-products",
  });
});

// Every R2 read sees a 10-byte object whose body matches its extension.
function mockR2() {
  fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
    if (init.method === "HEAD") {
      return new Response(null, {
        status: 200,
        headers: { "content-length": "10", etag: '"e"' },
      });
    }
    if (init.method === "DELETE") return new Response(null, { status: 204 });
    const body = url.includes(".pdf") ? "%PDF-1.4\n\n" : "plain text";
    return new Response(Uint8Array.from(Buffer.from(body)), { status: 206 });
  });
}

function seedVerified(): Asset {
  const row: Asset = {
    id: "as_1",
    productId: "dp_1",
    lineageId: "lin_1",
    storageKey: "products/dp_1/lin_1/as_1.pdf",
    mimeType: "application/pdf",
    sizeBytes: 10,
    order: 0,
    version: 1,
    status: "VERIFIED",
  };
  mockAssets.push(row);
  return row;
}

it("signs the PUT create-only so a verified object can never be overwritten", async () => {
  const url = new URL(
    createR2PresignedPutUrl({
      key: "products/dp_1/lin/as.pdf",
      bucket: "digital-products",
      contentType: "application/pdf",
      contentLength: 10,
      expiresInSeconds: 900,
      createOnly: true,
    }),
  );
  expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe(
    "content-length;content-type;host;if-none-match",
  );

  const reserved = await reservePendingAsset({
    product,
    fileName: "a.pdf",
    mimeType: "application/pdf",
    sizeBytes: 10,
  });
  expect(reserved.ok && reserved.upload.headers).toEqual({
    "Content-Type": "application/pdf",
    "If-None-Match": "*",
  });
  expect(mockLocks[0]).toMatch(/FOR UPDATE\|dp_1$/);
});

it("fences every inspection read to the HEAD's ETag and leaves a mutated upload PENDING", async () => {
  seedVerified();
  const pending: Asset = {
    ...mockAssets[0],
    id: "as_2",
    storageKey: "products/dp_1/lin_1/as_2.pdf",
    version: 2,
    status: "PENDING",
  };
  mockAssets.push(pending);
  fetchMock
    .mockResolvedValueOnce(
      new Response(null, {
        status: 200,
        headers: { "content-length": "10", etag: '"e1"' },
      }),
    )
    .mockResolvedValueOnce(new Response(null, { status: 412 }));

  expect(await verifyDigitalProductAsset(pending)).toEqual({
    status: "CHANGED",
  });
  const [, rangedGet] = fetchMock.mock.calls[1];
  expect(rangedGet.headers["if-match"]).toBe('"e1"');
  expect(pending.status).toBe("PENDING");
  expect(mockAssets[0].status).toBe("VERIFIED");
});

it("versions concurrent different-MIME replacements per lineage, retries past a rejection, and never lets an older version win", async () => {
  seedVerified();
  const [pdf, txt] = await Promise.all([
    reservePendingAsset({
      product,
      fileName: "v2.pdf",
      mimeType: "application/pdf",
      sizeBytes: 10,
      replacesAssetId: "as_1",
    }),
    reservePendingAsset({
      product,
      fileName: "v2.txt",
      mimeType: "text/plain",
      sizeBytes: 10,
      replacesAssetId: "as_1",
    }),
  ]);
  expect(pdf.ok && txt.ok).toBe(true);
  const [v2, v3] = mockAssets.slice(1);
  expect([v2.version, v3.version]).toEqual([2, 3]);
  expect(v2.lineageId).toBe("lin_1");
  expect(v3.storageKey).toMatch(/^products\/dp_1\/lin_1\/[0-9a-f-]{36}\.txt$/);

  // v3 settles first; the older v2 then passes inspection but must not become current.
  mockR2();
  expect(await verifyDigitalProductAsset(v3)).toEqual({ status: "VERIFIED" });
  expect(mockAssets[0].status).toBe("SUPERSEDED");
  expect(await verifyDigitalProductAsset(v2)).toEqual({
    status: "REJECTED",
    reason: "NEWER_VERSION_EXISTS",
  });
  expect(v3.status).toBe("VERIFIED");

  // A rejected version never blocks the next replacement: it takes v4.
  const retry = await reservePendingAsset({
    product,
    fileName: "v4.pdf",
    mimeType: "application/pdf",
    sizeBytes: 10,
    replacesAssetId: v3.id,
  });
  expect(retry.ok).toBe(true);
  expect(mockAssets.at(-1)?.version).toBe(4);
});

it("holds the final file slot and the final bytes under the product lock", async () => {
  for (let i = 0; i < 19; i++) {
    mockAssets.push({
      id: `as_${i}`,
      productId: "dp_1",
      lineageId: `lin_${i}`,
      storageKey: `products/dp_1/lin_${i}/as_${i}.pdf`,
      mimeType: "application/pdf",
      sizeBytes: MB,
      order: i,
      version: 1,
      status: "VERIFIED",
    });
  }
  const file = {
    product,
    fileName: "x.pdf",
    mimeType: "application/pdf" as const,
    sizeBytes: MB,
  };
  const slots = await Promise.all([
    reservePendingAsset(file),
    reservePendingAsset(file),
  ]);
  expect(slots.map((r) => (r.ok ? "ok" : r.refusal)).sort()).toEqual([
    "TOO_MANY_FILES",
    "ok",
  ]);

  mockAssets.length = 0;
  seedVerified().sizeBytes = 1024 * MB - 300 * MB;
  const big = { ...file, sizeBytes: 200 * MB };
  const bytes = await Promise.all([
    reservePendingAsset(big),
    reservePendingAsset(big),
  ]);
  expect(bytes.map((r) => (r.ok ? "ok" : r.refusal)).sort()).toEqual([
    "PRODUCT_TOO_LARGE",
    "ok",
  ]);
});

it("checks the category read under the lock, not the caller's earlier read", async () => {
  // A draft's switch to AUDIO commits after the route read TEMPLATE.
  mockProduct.category = "AUDIO";
  const refused = await reservePendingAsset({
    product,
    fileName: "a.pdf",
    mimeType: "application/pdf",
    sizeBytes: 10,
  });
  expect(refused).toEqual({ ok: false, refusal: "CATEGORY_MISMATCH" });
  expect(mockAssets).toHaveLength(0);
});

it("never promotes a replacement once its lineage's current file is deleted", async () => {
  seedVerified();
  mockR2();
  await reservePendingAsset({
    product,
    fileName: "v2.pdf",
    mimeType: "application/pdf",
    sizeBytes: 10,
    replacesAssetId: "as_1",
  });
  const v2 = { ...mockAssets[1] };
  const removed = await removeFile(new Request("http://localhost/x"), {
    params: Promise.resolve({ productId: "dp_1", assetId: "as_1" }),
  });
  expect((await removed.json()).data.status).toBe("SUPERSEDED");
  // The in-flight replacement was retired, its object deleted and its row cleared.
  expect(mockAssets.map((a) => [a.id, a.status])).toEqual([
    ["as_1", "SUPERSEDED"],
  ]);
  expect(await verifyDigitalProductAsset(v2)).toEqual({ status: "SETTLED" });

  // Any later version of the headless lineage is rejected, never made current.
  const v3: Asset = { ...v2, id: "as_3", version: 3, status: "PENDING" };
  mockAssets.push(v3);
  expect(await verifyDigitalProductAsset(v3)).toEqual({
    status: "REJECTED",
    reason: "LINEAGE_DELETED",
  });
});
