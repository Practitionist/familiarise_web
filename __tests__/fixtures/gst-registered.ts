/** A valid GSTIN in Haryana (06), the registered office's state in lib/company.ts. */
export const REGISTERED_TEST_GSTIN = "06AAFCF1234Q1ZN";

/** Runs the enclosing suite as a GST-registered platform and restores PLATFORM_GSTIN after it. */
export function runAsRegisteredPlatform(): void {
  let previous: string | undefined;
  beforeAll(() => {
    previous = process.env.PLATFORM_GSTIN;
    process.env.PLATFORM_GSTIN = REGISTERED_TEST_GSTIN;
  });
  afterAll(() => {
    if (previous === undefined) delete process.env.PLATFORM_GSTIN;
    else process.env.PLATFORM_GSTIN = previous;
  });
}
