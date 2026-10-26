/**
 * @jest-environment node
 *
 * The GST outward register heals at most `limit` payments, one transaction
 * each, uploads the CSV to a path fixed by the period, and stamps
 * `gstr1ExportedAt` only after that upload succeeds.
 */

const order: string[] = [];
const mockUpload = jest.fn(async (_a: { storagePath: string }) => {
  order.push("upload");
});
jest.mock("../../lib/storage/private-finance-object", () => ({
  uploadPrivateFinanceObject: (a: { storagePath: string }) => mockUpload(a),
}));
jest.mock("../../lib/cron/with-cron-lock", () => ({
  withCronLock: (_name: string, _opts: unknown, fn: () => unknown) => fn(),
}));
// The export refuses to write without the platform's own supplier identity;
// here it is configured, so the run proceeds.
jest.mock("../../lib/pdf/supplier", () => ({
  getPlatformSupplier: () => ({
    name: "Practitionist (OPC) Private Limited",
    gstin: "06AAFCF1234Q1ZN",
    address:
      "T 3 Fl 701, M3M Merlin, Main Gujjar Rd Sec 67, Gurgaon, Gurgaon - 122018, Haryana, India",
    email: "billing@familiarise.test",
  }),
}));
const mockMint = jest.fn(async () => ({ consumerInvoiceId: "ci" }));
jest.mock("../../lib/payments/billing/consumer-invoice", () => ({
  CONSUMER_INVOICEABLE_PAYMENT_WHERE: { billableToOrgInvoiceId: null },
  mintConsumerInvoice: () => mockMint(),
}));

const stamp = () =>
  jest.fn(async () => {
    order.push("stamp");
    return { count: 0 };
  });
const db = {
  payment: {
    findMany: jest.fn(async () => [{ id: "p1" }, { id: "p2" }]),
  },
  consumerInvoice: { findMany: jest.fn(async () => []), updateMany: stamp() },
  organizationInvoice: {
    findMany: jest.fn(async () => []),
    updateMany: stamp(),
  },
  consumerCreditNote: {
    findMany: jest.fn(async () => []),
    count: jest.fn(async () => 0),
    updateMany: stamp(),
  },
  creditNote: {
    findMany: jest.fn(async () => []),
    count: jest.fn(async () => 0),
    updateMany: stamp(),
  },
  $transaction: jest.fn(async (arg: unknown): Promise<unknown> =>
    typeof arg === "function" ? arg(db) : Promise.all(arg as unknown[]),
  ),
};
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  get default() {
    return db;
  },
}));

import { runGstOutwardRegisterExport } from "@/jobs/compliance/gst-outward-register-export";

beforeEach(() => {
  jest.useFakeTimers().setSystemTime(new Date("2026-11-02T04:45:00Z"));
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.clearAllMocks();
  order.length = 0;
});
afterEach(() => jest.useRealTimers());

it("bounds the healer, uploads the period CSV, then stamps", async () => {
  const result = await runGstOutwardRegisterExport({ limit: 2 });

  expect(db.payment.findMany).toHaveBeenCalledWith(
    expect.objectContaining({
      take: 2,
      where: expect.objectContaining({ billableToOrgInvoiceId: null }),
    }),
  );
  expect(mockMint).toHaveBeenCalledTimes(2);
  expect(result.mintedByHealer).toBe(2);
  expect(mockUpload.mock.calls[0][0].storagePath).toBe(
    "compliance/gst/2026-10-01_2026-10-31.csv",
  );
  expect(result.storagePath).toBe("compliance/gst/2026-10-01_2026-10-31.csv");
  expect(order).toEqual(["upload", "stamp", "stamp", "stamp", "stamp"]);
});

it("stamps nothing when the upload fails", async () => {
  mockUpload.mockRejectedValueOnce(new Error("bucket down"));

  await expect(runGstOutwardRegisterExport({ limit: 2 })).rejects.toThrow(
    "bucket down",
  );
  expect(order).toEqual([]);
  expect(db.consumerInvoice.updateMany).not.toHaveBeenCalled();
  expect(db.creditNote.updateMany).not.toHaveBeenCalled();
});
