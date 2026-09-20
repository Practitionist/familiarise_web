/**
 * @jest-environment node
 */

/**
 * #1675 PR-Y2 — one derivation of "what is still missing before you can be
 * paid". Y2-0: the requirements table over none / PAN-only / account-unverified
 * / all-set. Y2-1: `checkPayoutEligibility` names the first failing gate in
 * batch order, and null when eligible.
 */

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    consultantEarnings: { aggregate: jest.fn() },
    payoutAccount: { findFirst: jest.fn() },
    consultantTaxInfo: { findUnique: jest.fn() },
  },
}));
jest.mock("../../lib/feature-flags", () => ({
  ...jest.requireActual("../../lib/feature-flags"),
  ENABLE_LIVE_PAYOUTS: true,
}));
jest.mock("../../lib/redis", () => ({
  acquireLock: jest.fn(),
  releaseLock: jest.fn(),
  isMockRedis: jest.fn().mockReturnValue(false),
  checkRedisHealth: jest.fn(),
  isRedisCircuitOpen: jest.fn().mockReturnValue(false),
}));
jest.mock("../../lib/payments/tax/tds-service", () => ({
  getCurrentFYCumulativePayments: jest.fn(),
  getFYDateRange: jest.fn(),
  getIndianFinancialYear: jest.fn(),
  recordTDSDeduction: jest.fn(),
  TDS_THRESHOLD_PAISE: 5_000_000,
}));
jest.mock("../../lib/novu/service", () => ({
  notifyPayoutProcessed: jest.fn(),
}));

import {
  payoutRequirements,
  type PayoutRequirementsInput,
} from "@/lib/payments/payouts/payout-requirements";

const base: PayoutRequirementsInput = {
  consultantProfileId: "cp-1",
  taxInfo: null,
  defaultAccount: null,
  earningsCount: 1,
  isIndianResident: true,
  livePayoutsEnabled: true,
};
const codes = (r: { code: string }[]) => r.map((x) => x.code);

describe("Y2-0 payoutRequirements", () => {
  it.each([
    ["none", {}, ["PAYOUT_ACCOUNT", "PAN"], ["GSTIN"], true],
    [
      "PAN only",
      { defaultAccount: { isVerified: true } },
      ["PAN"],
      ["GSTIN"],
      false,
    ],
    [
      "account unverified",
      {
        defaultAccount: { isVerified: false },
        taxInfo: { panLast4: "234F", gstin: null },
      },
      ["ACCOUNT_VERIFICATION"],
      ["GSTIN"],
      true,
    ],
    [
      "all set",
      {
        defaultAccount: { isVerified: true },
        taxInfo: { panLast4: "234F", gstin: "27AAAAA0000A1Z5" },
      },
      [],
      [],
      false,
    ],
  ] as const)(
    "%s",
    (_name, overrides, currentlyDue, eventuallyDue, blocked) => {
      const out = payoutRequirements({ ...base, ...overrides });
      expect(codes(out.currentlyDue)).toEqual(currentlyDue);
      expect(codes(out.eventuallyDue)).toEqual(eventuallyDue);
      expect(out.blocked).toBe(blocked);
    },
  );

  it("nothing is due NOW before the first earning, and every href lands on the settings route", () => {
    const out = payoutRequirements({ ...base, earningsCount: 0 });
    expect(out.currentlyDue).toEqual([]);
    expect(codes(out.eventuallyDue)).toEqual([
      "PAYOUT_ACCOUNT",
      "PAN",
      "GSTIN",
    ]);
    for (const r of out.eventuallyDue) {
      expect(r.href).toMatch(
        /^\/dashboard\/consultant\/cp-1\/settings\/payouts#/,
      );
    }
  });
});
