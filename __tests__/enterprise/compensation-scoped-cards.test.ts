/**
 * @jest-environment node
 */

// Invariant: the expert's Compensation read lists the org's contract, plan-type
// and plan cards read-only, scoped to this org, beside the one effective card.

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    rateCard: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
    },
    consultationPlan: { findMany: jest.fn() },
    subscriptionPlan: { findMany: jest.fn() },
    webinarPlan: { findMany: jest.fn() },
    classPlan: { findMany: jest.fn() },
    organizationPayoutAccount: { findUnique: jest.fn() },
    organizationEarnings: { findMany: jest.fn() },
    consultantEarnings: { findMany: jest.fn() },
    appointment: { findMany: jest.fn() },
  },
}));

import prisma from "@/lib/prisma";
import { getMyArrangementData } from "@/lib/data/org-member-arrangement";

const m = prisma as unknown as Record<string, Record<string, jest.Mock>>;
const bps = { platformBps: 1000, orgBps: 1000, consultantBps: 8000 };

beforeEach(() => {
  jest.clearAllMocks();
  m.rateCard.findFirst.mockResolvedValue(null);
  m.rateCard.findUnique.mockResolvedValue(null);
  m.organizationEarnings.findMany.mockResolvedValue([]);
  m.appointment.findMany.mockResolvedValue([]);
  m.consultationPlan.findMany.mockResolvedValue([
    { id: "plan-1", title: "Career review" },
  ]);
});

const read = () =>
  getMyArrangementData({
    orgId: "org-1",
    payoutRecipient: "SELF",
    consultantProfileId: null,
    rateCardOverrideId: "override-1",
  });

it("labels contract, plan-type and plan cards by scope and resolves plan titles", async () => {
  m.rateCard.findMany.mockResolvedValue([
    {
      id: "c1",
      planType: null,
      planId: null,
      ...bps,
      effectiveFrom: new Date(),
      ownerContract: { effectiveFrom: new Date("2026-01-01") },
    },
    {
      id: "t1",
      planType: "CLASS",
      planId: null,
      ...bps,
      effectiveFrom: new Date(),
      ownerContract: null,
    },
    {
      id: "p1",
      planType: "CONSULTATION",
      planId: "plan-1",
      ...bps,
      effectiveFrom: new Date(),
      ownerContract: null,
    },
  ]);

  const { scopedRateCards } = await read();

  expect(scopedRateCards.map((c) => c.scope)).toEqual([
    "contract",
    "planType",
    "plan",
  ]);
  expect(scopedRateCards[2]).toMatchObject({
    planType: "CONSULTATION",
    planTitle: "Career review",
  });
  expect(m.consultationPlan.findMany).toHaveBeenCalledWith({
    where: { id: { in: ["plan-1"] }, organizationId: "org-1" },
    select: { id: true, title: true },
  });
});

it("reads only this org's live narrower cards, never the applied or override card", async () => {
  m.rateCard.findMany.mockResolvedValue([]);

  await read();

  const [{ where }] = m.rateCard.findMany.mock.calls[0];
  expect(where.id).toEqual({ notIn: ["override-1"] });
  expect(JSON.stringify(where.AND)).toContain('"ownerOrgId":"org-1"');
  expect(JSON.stringify(where.AND)).toContain(
    '"ownerContract":{"organizationId":"org-1","status":"ACTIVE"}',
  );
  expect(m.consultationPlan.findMany).not.toHaveBeenCalled();
});

it("lists no scoped card while the expert's membership override wins, and skips the read", async () => {
  m.rateCard.findFirst.mockResolvedValue({
    id: "override-1",
    platformBps: 500,
    orgBps: 500,
    consultantBps: 9000,
  });
  m.rateCard.findMany.mockResolvedValue([
    {
      id: "t1",
      planType: "CLASS",
      planId: null,
      ...bps,
      effectiveFrom: new Date(),
      ownerContract: null,
    },
  ]);

  const { rateCard, scopedRateCards } = await read();

  expect(rateCard).toMatchObject({ source: "yours", consultantBps: 9000 });
  expect(scopedRateCards).toEqual([]);
  expect(m.rateCard.findMany).not.toHaveBeenCalled();
});

it("keeps the plan scope of contract-owned cards so two of them stay distinguishable", async () => {
  m.webinarPlan.findMany.mockResolvedValue([
    { id: "web-1", title: "Intro webinar" },
  ]);
  m.rateCard.findMany.mockResolvedValue([
    {
      id: "c-class",
      planType: "CLASS",
      planId: null,
      ...bps,
      effectiveFrom: new Date(),
      ownerContract: { effectiveFrom: new Date("2026-01-01") },
    },
    {
      id: "c-web",
      planType: "WEBINAR",
      planId: "web-1",
      ...bps,
      effectiveFrom: new Date(),
      ownerContract: { effectiveFrom: new Date("2026-01-01") },
    },
  ]);

  const { scopedRateCards } = await read();

  expect(scopedRateCards).toEqual([
    expect.objectContaining({
      scope: "contract",
      planType: "CLASS",
      planSpecific: false,
      planTitle: null,
    }),
    expect.objectContaining({
      scope: "contract",
      planType: "WEBINAR",
      planSpecific: true,
      planTitle: "Intro webinar",
    }),
  ]);
});

it("lists only live sessions as upcoming: a cancelled or replaced session is left out", async () => {
  await getMyArrangementData({
    orgId: "org-1",
    payoutRecipient: "SELF",
    consultantProfileId: "cp-1",
    rateCardOverrideId: null,
  });
  const args = m.appointment.findMany.mock.calls[0]?.[0];
  const live = {
    deletedAt: null,
    completionStatus: { notIn: ["CANCELLED", "RESCHEDULED"] },
  };
  expect(args.where.occurrences.some).toMatchObject(live);
  expect(args.select.occurrences.where).toMatchObject(live);
});
