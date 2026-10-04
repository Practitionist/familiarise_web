/**
 * @jest-environment node
 */

/**
 * The payout detail read binds the payout and its earnings to the consultant
 * profile in the WHERE: another consultant's payout never comes back.
 */

type Where = { id: string; consultantProfileId: string };
const T = new Date("2026-10-01T00:00:00Z");
const ROWS = [
  {
    id: "po-1",
    consultantProfileId: "cp-owner",
    status: "COMPLETED",
    method: "BANK_TRANSFER",
    currency: "INR",
    amount: 10000,
    tdsDeducted: 100,
    netAmount: 9900,
    tdsRateAppliedBps: 100,
    tdsFinancialYear: "2026-27",
    gatewayUtr: "UTR123",
    failureReason: null,
    createdAt: T,
    approvedAt: T,
    processedAt: T,
    updatedAt: T,
    earnings: [
      {
        id: "e-1",
        grossAmount: 12500,
        consultantSharePaise: 10000,
        payment: {
          createdAt: T,
          capturedAt: null,
          description: null,
          appointment: {
            consultation: { consultationPlan: { title: "Career call" } },
          },
        },
      },
    ],
  },
];

const findFirst = jest.fn(async ({ where }: { where: Where }) => {
  return (
    ROWS.find(
      (r) =>
        r.id === where.id &&
        r.consultantProfileId === where.consultantProfileId,
    ) ?? null
  );
});

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: { consultantPayout: { findFirst: (arg: never) => findFirst(arg) } },
}));

import { readConsultantPayoutDetail } from "@/lib/data/consultant-payout-detail";

it("returns the owner's payout with its UTR and linked earnings", async () => {
  const out = await readConsultantPayoutDetail({
    payoutId: "po-1",
    consultantProfileId: "cp-owner",
  });
  expect(out).toMatchObject({
    netPaise: 9900,
    tdsPaise: 100,
    utr: "UTR123",
    earnings: [{ offering: "Career call", sharePaise: 10000 }],
  });
});

it("never returns another consultant's payout", async () => {
  const out = await readConsultantPayoutDetail({
    payoutId: "po-1",
    consultantProfileId: "cp-intruder",
  });
  expect(out).toBeNull();
  const call = findFirst.mock.calls.at(-1)?.[0] as unknown as {
    where: Where;
    select: { earnings: { where: { consultantProfileId: string } } };
  };
  expect(call.where.consultantProfileId).toBe("cp-intruder");
  expect(call.select.earnings.where.consultantProfileId).toBe("cp-intruder");
});
