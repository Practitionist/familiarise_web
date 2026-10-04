/**
 * @jest-environment node
 */

/**
 * The pending-checkout read puts the viewer in the WHERE: another user's
 * payment never comes back, and the select names only rendered columns.
 */

type Where = { id: string; userId: string };
const ROWS = [
  {
    id: "pay-owner",
    userId: "user-owner",
    paymentStatus: "PENDING",
    amount: 11800,
    originalAmount: 10000,
    taxAmount: 1800,
    currency: "INR",
    expiresAt: null,
    appointmentId: "apt-1",
    discountCode: null,
    creditUsages: [],
    user: { consulteeProfile: { id: "ce-owner" } },
    appointment: null,
  },
];

const findFirst = jest.fn(async ({ where }: { where: Where }) => {
  return (
    ROWS.find((r) => r.id === where.id && r.userId === where.userId) ?? null
  );
});

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: { payment: { findFirst: (arg: never) => findFirst(arg) } },
}));

import { readPendingCheckout } from "@/lib/data/pending-checkout";

it("returns the viewer's own charge with a derived breakdown", async () => {
  const out = await readPendingCheckout({
    paymentId: "pay-owner",
    viewerUserId: "user-owner",
  });
  expect(out).toMatchObject({
    paymentId: "pay-owner",
    basePaise: 10000,
    taxPaise: 1800,
    totalPaise: 11800,
    discountPaise: 0,
    creditsPaise: 0,
    consulteeProfileId: "ce-owner",
  });
});

it("never returns another user's payment", async () => {
  const out = await readPendingCheckout({
    paymentId: "pay-owner",
    viewerUserId: "user-intruder",
  });
  expect(out).toBeNull();
  const call = findFirst.mock.calls.at(-1)?.[0] as unknown as {
    where: { userId: string };
    select: Record<string, unknown>;
  };
  expect(call.where.userId).toBe("user-intruder");
  expect(call.select).not.toHaveProperty("paymentIntent");
  expect(call.select).not.toHaveProperty("gatewayPaymentId");
});
