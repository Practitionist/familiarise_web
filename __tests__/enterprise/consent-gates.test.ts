/**
 * @jest-environment node
 */

/**
 * #701 — the fail-closed contract the new consent gates (org-sponsored checkout,
 * invite acceptance, data export) all depend on: checkConsent returns true ONLY
 * for a live, non-withdrawn, non-expired artifact carrying the purpose code.
 */

const mockFindFirst = jest.fn();

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: { consentArtifact: { findFirst: (...a: unknown[]) => mockFindFirst(...a) } },
}));

import { checkConsent } from "@/lib/compliance/dpdp";
import { PURPOSE_CODES } from "@/lib/compliance/purpose-codes";

beforeEach(() => mockFindFirst.mockReset());

describe("checkConsent — fail-closed (#701)", () => {
  it("is true when a live artifact for the purpose exists", async () => {
    mockFindFirst.mockResolvedValue({ id: "c1" });
    const ok = await checkConsent({
      userId: "u1",
      purposeCode: PURPOSE_CODES.SESSION_BOOKING,
    });
    expect(ok).toBe(true);
    // The query must filter withdrawn + expired out and match the purpose code.
    const where = mockFindFirst.mock.calls[0][0].where;
    expect(where.userId).toBe("u1");
    expect(where.purposeCodes).toEqual({ has: PURPOSE_CODES.SESSION_BOOKING });
    expect(where.withdrawnAt).toBeNull();
    expect(where.auditRetainedUntil.gt).toBeInstanceOf(Date);
  });

  it("is false (fail-closed) when no matching artifact exists", async () => {
    mockFindFirst.mockResolvedValue(null);
    const ok = await checkConsent({
      userId: "u1",
      purposeCode: PURPOSE_CODES.PRIMARY_PROCESSING,
    });
    expect(ok).toBe(false);
  });

  it("SESSION_BOOKING + PRIMARY_PROCESSING are canonical codes the gates use", () => {
    expect(PURPOSE_CODES.SESSION_BOOKING).toBe("SESSION_BOOKING");
    expect(PURPOSE_CODES.PRIMARY_PROCESSING).toBe("PRIMARY_PROCESSING");
  });
});
