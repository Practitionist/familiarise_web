/**
 * @jest-environment node
 *
 * The supplier on tax invoices, credit notes and IRP payloads is the legal
 * entity in lib/company.ts; its GST state is the GSTIN's first two digits.
 */

import { getPlatformSupplier } from "@/lib/pdf/supplier";
import {
  SupplierStateMismatchError,
  supplierStateCode,
} from "@/lib/payments/billing/consumer-invoice";

const OLD_GSTIN = process.env.PLATFORM_GSTIN;
afterEach(() => {
  if (OLD_GSTIN === undefined) delete process.env.PLATFORM_GSTIN;
  else process.env.PLATFORM_GSTIN = OLD_GSTIN;
});

describe("platform supplier identity", () => {
  it("prints Practitionist's registered office in Haryana next to the GSTIN", () => {
    process.env.PLATFORM_GSTIN = "06AAFCF1234Q1ZN";
    expect(getPlatformSupplier()).toMatchObject({
      name: "Practitionist (OPC) Private Limited",
      gstin: "06AAFCF1234Q1ZN",
      address:
        "T 3 Fl 701, M3M Merlin, Main Gujjar Rd Sec 67, Gurgaon, Gurgaon - 122018, Haryana, India",
    });
    expect(supplierStateCode()).toBe("06");
  });

  it("issues nothing without a well-formed GSTIN, and refuses one from another state", () => {
    process.env.PLATFORM_GSTIN = "not-a-gstin";
    expect(getPlatformSupplier()).toBeNull();

    process.env.PLATFORM_GSTIN = "29AAFCF1234Q1ZN";
    expect(() => supplierStateCode()).toThrow(SupplierStateMismatchError);
  });
});
