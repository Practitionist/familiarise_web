/**
 * @jest-environment node
 */

/**
 * An archived product leaves discovery but stays reachable to its buyers: a
 * consultant-only buyer (no learner library) follows the receipt's product
 * link to their purchases page, opens the archived product and downloads; a
 * taken-down product never loads.
 */
jest.mock("server-only", () => ({}));
jest.mock("react", () => ({
  ...jest.requireActual("react"),
  cache: <T>(fn: T) => fn,
}));
jest.mock("../../lib/auth-helpers", () => ({
  requireApiAuth: async () => ({
    session: {
      user: { id: "buyer_cp", consultantProfileId: "cp_buyer", role: "USER" },
    },
  }),
  isPrivileged: () => false,
}));
jest.mock("../../lib/rate-limit", () => ({
  applyRateLimit: async () => null,
  digitalProductDownloadLimiter: {},
}));
jest.mock("../../lib/storage/r2-client", () => ({
  createR2PresignedGetUrl: () => "https://r2/signed",
}));
const prepareEmail = jest.fn(async (args: object) => ({ args }));
jest.mock("../../lib/email/senders/money", () => ({
  MONEY_EMAIL_TYPES: {},
  prepareDigitalProductPurchaseEmail: (args: object) => prepareEmail(args),
}));

const product = {
  id: "dp_1",
  slug: "workbook-1a2b",
  title: "Workbook",
  status: "ARCHIVED",
  takenDownAt: null as Date | null,
  visibility: "PUBLIC",
  buyers: ["buyer_cp"],
};
const row = {
  id: "dp_1",
  slug: "workbook-1a2b",
  title: "Workbook",
  subtitle: null,
  description: "d",
  category: "DOCUMENT",
  pricePaise: 50_000,
  coverImagePath: null,
  publishedAt: null,
  consultantProfile: {
    id: "cp_owner",
    headline: null,
    user: { name: "Hannah", image: null },
  },
  assets: [
    {
      id: "as_1",
      lineageId: "as_1",
      version: 1,
      originalName: "w.pdf",
      mimeType: "application/pdf",
      sizeBytes: 1,
    },
  ],
};
interface ProductWhere {
  status: string | { in: string[] };
  takenDownAt: null;
  purchases?: { some: { buyerId: string } };
}
const tx = {
  $queryRaw: async () => [{ id: "dpp_1" }],
  digitalProductPurchase: { updateMany: async () => ({ count: 1 }) },
  digitalProductDownload: { create: jest.fn(async () => ({})) },
};
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    digitalProduct: {
      findFirst: async ({ where }: { where: ProductWhere }) => {
        const statusOk =
          typeof where.status === "string"
            ? where.status === product.status
            : where.status.in.includes(product.status);
        const buyerOk =
          !where.purchases ||
          product.buyers.includes(where.purchases.some.buyerId);
        return statusOk && buyerOk && product.takenDownAt === null ? row : null;
      },
      findUnique: async () => ({
        slug: product.slug,
        title: product.title,
        consultantProfile: { user: { name: "Hannah" } },
      }),
    },
    user: {
      findUnique: async () => ({
        consulteeProfileId: null,
        consultantProfileId: "cp_buyer",
      }),
    },
    digitalProductAsset: {
      findFirst: async () => ({
        id: "as_1",
        lineageId: "as_1",
        version: 1,
        status: "VERIFIED",
        storageKey: "products/dp_1/lin/as_1.pdf",
        originalName: "w.pdf",
        product: {
          consultantProfileId: "cp_owner",
          takenDownAt: product.takenDownAt,
        },
      }),
    },
    $transaction: (cb: (t: typeof tx) => Promise<unknown>) => cb(tx),
  },
}));

import {
  getEntitledDigitalProductBySlug,
  getPublicDigitalProductBySlug,
} from "../../lib/data/digital-products-public";
import { prepareDigitalProductReceipt } from "../../lib/digital-products/purchase-email";
import { GET as download } from "../../app/api/digital-products/[productId]/assets/[assetId]/download/route";

it("opens an archived product's download view to a consultant-only buyer and nobody else", async () => {
  process.env.R2_DIGITAL_PRODUCTS_BUCKET = "digital-products";
  await prepareDigitalProductReceipt({
    purchaseId: "dpp_1",
    buyerId: "buyer_cp",
    productId: "dp_1",
    amountPaise: 59_000,
  });
  expect(prepareEmail).toHaveBeenCalledWith(
    expect.objectContaining({
      libraryHref: "/dashboard/go/library?tab=purchases",
    }),
  );

  expect(await getPublicDigitalProductBySlug(product.slug)).toBeNull();
  expect(
    await getEntitledDigitalProductBySlug(product.slug, "buyer_cp"),
  ).toMatchObject({ id: "dp_1", files: [{ id: "as_1" }] });
  expect(
    await getEntitledDigitalProductBySlug(product.slug, "stranger"),
  ).toBeNull();

  const res = await download(new Request("http://localhost/x"), {
    params: Promise.resolve({ productId: "dp_1", assetId: "as_1" }),
  });
  expect(res.status).toBe(302);
  expect(tx.digitalProductDownload.create).toHaveBeenCalledTimes(1);

  product.takenDownAt = new Date();
  expect(
    await getEntitledDigitalProductBySlug(product.slug, "buyer_cp"),
  ).toBeNull();
});
