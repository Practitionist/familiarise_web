/**
 * @jest-environment node
 */

import { isPlatformGstRegistered } from "@/lib/pdf/supplier";

const OLD_GSTIN = process.env.PLATFORM_GSTIN;
afterEach(() => {
  if (OLD_GSTIN === undefined) delete process.env.PLATFORM_GSTIN;
  else process.env.PLATFORM_GSTIN = OLD_GSTIN;
});

describe("isPlatformGstRegistered", () => {
  it("is true for a valid GSTIN from the registered office's state", () => {
    process.env.PLATFORM_GSTIN = "06AAFCF1234Q1ZN";
    expect(isPlatformGstRegistered()).toBe(true);
  });

  it("is false when unset, malformed or from another state", () => {
    delete process.env.PLATFORM_GSTIN;
    expect(isPlatformGstRegistered()).toBe(false);
    process.env.PLATFORM_GSTIN = "not-a-gstin";
    expect(isPlatformGstRegistered()).toBe(false);
    process.env.PLATFORM_GSTIN = "29AAFCF1234Q1ZN";
    expect(isPlatformGstRegistered()).toBe(false);
  });
});
