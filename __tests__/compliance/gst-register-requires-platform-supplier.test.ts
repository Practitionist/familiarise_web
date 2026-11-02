/**
 * @jest-environment node
 *
 * The register needs the platform's supplier identity: an unset PLATFORM_GSTIN
 * is a config skip that never reaches Sentry, and a set but unusable one throws.
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

jest.mock("../../lib/observability/report", () => ({
  reportSentryMessage: jest.fn(),
  reportSentryError: jest.fn(),
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
import {
  reportSentryError,
  reportSentryMessage,
} from "@/lib/observability/report";

const OLD_GSTIN = process.env.PLATFORM_GSTIN;
beforeEach(() => {
  order.length = 0;
  mockUpload.mockClear();
  mockMint.mockClear();
  process.env.PLATFORM_GSTIN = "06AAFCF1234Q1ZN";
});
afterAll(() => {
  if (OLD_GSTIN === undefined) delete process.env.PLATFORM_GSTIN;
  else process.env.PLATFORM_GSTIN = OLD_GSTIN;
});

it("records a config skip without touching rows or Sentry while PLATFORM_GSTIN is unset", async () => {
  delete process.env.PLATFORM_GSTIN;
  jest.spyOn(console, "warn").mockImplementation(() => {});

  const result = await runGstOutwardRegisterExport({ limit: 25 });

  expect(result.skipped).toBe("PLATFORM_GSTIN not configured");
  expect(mockUpload).not.toHaveBeenCalled();
  expect(mockMint).not.toHaveBeenCalled();
  expect(order).toEqual([]);
  expect(reportSentryMessage).not.toHaveBeenCalled();
  expect(reportSentryError).not.toHaveBeenCalled();
});

it.each([
  ["malformed", "not-a-gstin"],
  ["from another state", "29AAFCF1234Q1ZN"],
])("throws before any write when the GSTIN is %s", async (_label, gstin) => {
  process.env.PLATFORM_GSTIN = gstin;

  await expect(runGstOutwardRegisterExport({ limit: 25 })).rejects.toThrow(
    /PLATFORM_GSTIN/,
  );
  expect(mockUpload).not.toHaveBeenCalled();
  expect(order).toEqual([]);
});

it("uploads the register and only then stamps the period when the supplier is configured", async () => {
  await runGstOutwardRegisterExport({ limit: 25 });

  expect(mockUpload).toHaveBeenCalledTimes(1);
  // The upload is first; every stamp of a reported document follows it.
  expect(order[0]).toBe("upload");
  expect(order.slice(1).every((step) => step === "stamp")).toBe(true);
});
