/** @jest-environment node */
jest.mock("react", () => ({ cache: (fn: unknown) => fn }));
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: { consultantProfile: { findUnique: jest.fn() } },
}));
jest.mock("../../lib/observability/report", () => ({
  reportSentryError: jest.fn(),
}));
import prisma from "@/lib/prisma";
import { getConsultantDetail } from "@/lib/data/consultant-detail";

it("reads only three public curriculum milestones, never content URLs or learner resources", async () => {
  (prisma.consultantProfile.findUnique as jest.Mock).mockResolvedValue(null);
  await getConsultantDetail("expert");
  const args = (prisma.consultantProfile.findUnique as jest.Mock).mock
    .calls[0][0];
  expect(args.select.subscriptionPlans.include.subscriptionContents).toEqual({
    orderBy: { order: "asc" },
    take: 3,
    select: { id: true, title: true, order: true, outcomes: true },
  });
});
