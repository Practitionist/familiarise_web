/**
 * @jest-environment node
 *
 * The outward-supplies register is a statutory working file. Without the
 * platform's own supplier identity the healer cannot mint a consumer invoice,
 * so the register would read as a month with no B2C supplies — a silent
 * understatement. The export must refuse instead.
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

let supplierConfigured = true;
jest.mock("../../lib/pdf/supplier", () => ({
  ...jest.requireActual("../../lib/pdf/supplier"),
  getPlatformSupplier: () =>
    supplierConfigured
      ? {
          name: "Practitionist (OPC) Private Limited",
          gstin: "06AAFCF1234Q1ZN",
          address:
            "T 3 Fl 701, M3M Merlin, Main Gujjar Rd Sec 67, Gurgaon, Gurgaon - 122018, Haryana, India",
          email: "billing@familiarise.test",
        }
      : null,
}));

jest.mock("@sentry/nextjs", () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn() },
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
  payment: { findMany: jest.fn(async () => []) },
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
  order.length = 0;
  supplierConfigured = true;
  mockUpload.mockClear();
  mockMint.mockClear();
});

it("refuses to write a register when the platform supplier is not configured", async () => {
  supplierConfigured = false;

  await expect(runGstOutwardRegisterExport({ limit: 25 })).rejects.toThrow(
    /PLATFORM_GSTIN/,
  );

  // Nothing was uploaded and nothing was stamped: a refused run leaves the
  // period un-stamped so the next slice tries again.
  expect(mockUpload).not.toHaveBeenCalled();
  expect(mockMint).not.toHaveBeenCalled();
  expect(order).toEqual([]);
});

it("uploads the register and only then stamps the period when the supplier is configured", async () => {
  await runGstOutwardRegisterExport({ limit: 25 });

  expect(mockUpload).toHaveBeenCalledTimes(1);
  // The upload is first; every stamp of a reported document follows it.
  expect(order[0]).toBe("upload");
  expect(order.slice(1).every((step) => step === "stamp")).toBe(true);
});
