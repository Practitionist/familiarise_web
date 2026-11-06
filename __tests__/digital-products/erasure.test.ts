/**
 * @jest-environment node
 */

/** Erasure retires an erased creator's files and keeps only the buyer rows a Payment holds. */
const r2Delete = jest.fn(async (_opts: { key: string }) => ({ success: true }));
jest.mock("../../lib/storage/r2-client", () => ({
  deleteR2Object: (opts: { key: string }) => r2Delete(opts),
}));
jest.mock("../../lib/observability/report", () => ({
  reportSentryError: jest.fn(),
}));

import {
  purgeErasedCreatorFiles,
  scrubDigitalProductsTx,
} from "../../lib/digital-products/erasure";
import type { Db, Tx } from "../../lib/prisma";

const updateMany = jest.fn(async () => ({ count: 1 }));
const deleteMany = jest.fn(async () => ({ count: 1 }));
const db = {
  digitalProduct: { updateMany, findMany: jest.fn(async () => []) },
  digitalProductAsset: {
    updateMany,
    findMany: jest.fn(async () => [
      { id: "a1", storageKey: "products/p/a1/v1.pdf" },
    ]),
  },
  digitalProductDownload: { deleteMany },
  digitalProductPurchase: { deleteMany },
  digitalProductReport: { updateMany },
};

it("archives the creator's products, drops the buyer's unpaid rows and purges files", async () => {
  process.env.R2_DIGITAL_PRODUCTS_BUCKET = "digital-products";
  const now = new Date();
  await scrubDigitalProductsTx(db as unknown as Tx, "u1", now);
  expect(deleteMany).toHaveBeenCalledWith({
    where: {
      buyerId: "u1",
      paymentId: null,
      OR: [{ amountPaise: 0 }, { status: "FAILED" }],
    },
  });
  expect(updateMany).toHaveBeenCalledWith({
    where: { reporterId: "u1" },
    data: { reason: "[erased]" },
  });

  await expect(
    purgeErasedCreatorFiles(db as unknown as Db, "u1", now),
  ).resolves.toEqual([]);
  expect(r2Delete).toHaveBeenCalledWith({
    key: "products/p/a1/v1.pdf",
    bucket: "digital-products",
  });
  expect(updateMany).toHaveBeenLastCalledWith({
    where: { id: { in: ["a1"] }, purgedAt: null },
    data: { purgedAt: now },
  });
});
