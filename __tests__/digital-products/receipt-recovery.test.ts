/**
 * @jest-environment node
 */

/**
 * A receipt that could not be prepared when a paid capture settled or a free
 * claim committed stays owed, and the recovery pass stages it exactly once; a
 * buyer's opt-out is handled as a no-op and never retried.
 */
interface Row {
  id: string;
  buyerId: string;
  productId: string;
  amountPaise: number;
  status: string;
  createdAt: Date;
  receiptStagedAt: Date | null;
  reconciledAt: Date | null;
}
const mockRows: Row[] = [];
const mockLookupFails = { next: false };
const mockStaged: string[] = [];

jest.mock("../../lib/observability/report", () => ({
  reportSentryError: jest.fn(),
}));
jest.mock("../../lib/novu/stage-then-attempt", () => ({
  flushNotificationsAfter: jest.fn(),
}));
jest.mock("../../lib/email/senders/money", () => ({
  MONEY_EMAIL_TYPES: { DIGITAL_PRODUCT_PURCHASED: "DIGITAL_PRODUCT_PURCHASED" },
  prepareDigitalProductPurchaseEmail: async (args: {
    purchaseId: string;
    buyerId: string;
  }) => ({
    purchaseId: args.purchaseId,
    buyerId: args.buyerId,
    prepared:
      args.buyerId === "u_optout"
        ? { messages: [], skipped: 1, failed: 0 }
        : { messages: [{ to: "b@x.in" }], skipped: 0, failed: 0 },
  }),
  stageDigitalProductPurchaseEmail: async (
    _tx: unknown,
    r: { purchaseId: string; prepared: { messages: unknown[] } },
  ) => {
    if (r.prepared.messages.length === 0) return [];
    mockStaged.push(r.purchaseId);
    return [{ staged: { id: `fe_${r.purchaseId}` } }];
  },
}));
jest.mock("../../lib/prisma", () => {
  const purchase = {
    findMany: async () =>
      mockRows.filter((r) => r.status === "SUCCEEDED" && !r.receiptStagedAt),
    updateMany: async ({
      where,
      data,
    }: {
      where: { id: string };
      data: Partial<Row>;
    }) => {
      const row = mockRows.find((r) => r.id === where.id && !r.receiptStagedAt);
      if (row) Object.assign(row, data);
      return { count: row ? 1 : 0 };
    },
  };
  return {
    __esModule: true,
    default: {
      $transaction: (cb: (tx: unknown) => unknown) =>
        cb({ digitalProductPurchase: purchase }),
      digitalProductPurchase: purchase,
      digitalProduct: {
        findUnique: async () => {
          if (mockLookupFails.next) throw new Error("db timeout");
          return {
            slug: "guide",
            title: "Guide",
            consultantProfile: { user: { name: "Hannah" } },
          };
        },
      },
      user: { findUnique: async () => ({ consulteeProfileId: "cc_1" }) },
    },
  };
});

import {
  prepareDigitalProductReceipt,
  stageDigitalProductReceipt,
  stageOwedDigitalProductReceipts,
} from "../../lib/digital-products/purchase-email";
import prisma from "../../lib/prisma";

const ago = (ms: number) => new Date(Date.now() - ms);

it("stages an owed receipt once for a paid capture and a free claim, and none for an opt-out", async () => {
  const sale = (id: string, buyerId: string, amountPaise: number): Row => ({
    id,
    buyerId,
    productId: "dp_1",
    amountPaise,
    status: "SUCCEEDED",
    createdAt: ago(60 * 60_000),
    receiptStagedAt: null,
    reconciledAt: null,
  });
  mockRows.push(
    sale("dpp_paid", "u_paid", 59_000),
    sale("dpp_free", "u_free", 0),
    sale("dpp_optout", "u_optout", 59_000),
  );

  // The settling and claiming transactions after a failed preparation commit no receipt.
  mockLookupFails.next = true;
  for (const row of mockRows.slice(0, 2)) {
    const receipt = await prepareDigitalProductReceipt({
      ...row,
      purchaseId: row.id,
    });
    await prisma.$transaction((tx) => stageDigitalProductReceipt(tx, receipt));
  }
  expect(mockStaged).toEqual([]);
  expect(mockRows.every((r) => r.receiptStagedAt === null)).toBe(true);

  mockLookupFails.next = false;
  const first = await stageOwedDigitalProductReceipts(5, new Date());
  expect(first).toMatchObject({ checked: 3, handled: 3, failedIds: [] });
  expect(mockStaged).toEqual(["dpp_paid", "dpp_free"]);
  expect(mockRows.every((r) => r.receiptStagedAt)).toBe(true);

  const second = await stageOwedDigitalProductReceipts(5, new Date());
  expect(second.checked).toBe(0);
  expect(mockStaged).toHaveLength(2);
});
