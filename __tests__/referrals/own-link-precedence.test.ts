/**
 * @jest-environment node
 */

// Attribution order is relationship, then the expert's own-link token, then a consumer
// referral: a buyer holding both a valid own-link token and a referral pays the own-link
// rate with no welcome discount.

const db = {
  platformFeeSchedule: { findFirst: jest.fn() },
  referralProgramConfig: { findUnique: jest.fn() },
  expertCustomerRelationship: { findUnique: jest.fn() },
  referral: { findFirst: jest.fn() },
  payment: { count: jest.fn() },
  consultantFeeWaiver: { findFirst: jest.fn() },
};
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: { $transaction: (fn: (t: unknown) => unknown) => fn(db) },
}));

import prisma, { type Tx } from "@/lib/prisma";
import { resolveCheckoutAttribution } from "@/lib/referrals/attribution";
import { expertShareHref } from "@/lib/referrals/attribution-token";

const CONSULTANT = "cp-abcdefgh";
const typedTx = (): Promise<Tx> => prisma.$transaction(async (t) => t);
const ownLinkToken = () =>
  decodeURIComponent(expertShareHref(CONSULTANT).split("via=")[1]);
const attribute = async (viaToken: string | null) =>
  resolveCheckoutAttribution(await typedTx(), {
    buyerUserId: "buyer",
    consultantProfileId: CONSULTANT,
    consultantUserId: "expert",
    viaToken,
    orgFunded: false,
    hasDiscountCode: false,
  });

beforeAll(() => {
  process.env.BETTER_AUTH_SECRET = "a-test-secret-of-sufficient-length";
});
afterAll(() => {
  delete process.env.BETTER_AUTH_SECRET;
});

beforeEach(() => {
  jest.clearAllMocks();
  db.platformFeeSchedule.findFirst.mockResolvedValue({
    id: "fs-1",
    marketplaceBps: 2000,
    ownLinkBps: 1000,
  });
  db.referralProgramConfig.findUnique.mockResolvedValue({
    isActive: true,
    paused: false,
    monthlyBudgetPaise: 100_000,
    currentMonthSpentPaise: 0,
    discountBps: 2000,
    discountMaxPaise: 30_000,
    redemptionCapBps: 2000,
    minOrderPaise: 0,
    qualifyWindowDays: 30,
  });
  db.expertCustomerRelationship.findUnique.mockResolvedValue(null);
  db.referral.findFirst.mockResolvedValue({
    id: "ref-1",
    referralCode: { userId: "referrer" },
  });
  db.payment.count.mockResolvedValue(0);
  db.consultantFeeWaiver.findFirst.mockResolvedValue(null);
});

it("resolves OWN_LINK over a live consumer referral, with no welcome discount", async () => {
  const a = await attribute(ownLinkToken());
  expect(a).toMatchObject({
    source: "OWN_LINK",
    referralId: null,
    platformFeeBps: 1000,
    welcomeDiscount: null,
  });
  expect(db.referral.findFirst).not.toHaveBeenCalled();
});

it("resolves the same buyer to CONSUMER_REFERRAL without the own-link token", async () => {
  const a = await attribute(null);
  expect(a).toMatchObject({
    source: "CONSUMER_REFERRAL",
    referralId: "ref-1",
    platformFeeBps: 2000,
    welcomeDiscount: { bps: 2000 },
  });
});

it("keeps an existing relationship's source over the own-link token", async () => {
  db.expertCustomerRelationship.findUnique.mockResolvedValue({
    source: "MARKETPLACE",
  });
  const a = await attribute(ownLinkToken());
  expect(a).toMatchObject({
    source: "MARKETPLACE",
    platformFeeBps: 2000,
    welcomeDiscount: null,
  });
});
