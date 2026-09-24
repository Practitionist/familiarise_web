/**
 * @jest-environment node
 */

// #1771 rows 1 and 5 — erasure deletes saved-card tokens, deactivates the
// RazorpayX objects, nulls the masked bank fields and keeps the rzp ids.
jest.mock("../../lib/enterprise/outbound-webhooks/dispatch", () => ({
  dispatchWebhookEvent: jest.fn(),
}));
jest.mock("../../lib/enterprise/system-events", () => ({
  recordSystemErrorSafe: jest.fn(async () => undefined),
}));
const vendor = {
  deleteTokens: jest.fn(async (_customerId: string) => 2),
  deactivateFundAccount: jest.fn(async () => ({})),
  deactivateContact: jest.fn(async () => ({})),
};
const erasePii = jest.fn(async (_customerId: string, _userId: string) => {});
jest.mock("../../lib/payments/core/razorpay", () => ({
  deleteRazorpayCustomerTokens: (id: string) => vendor.deleteTokens(id),
  eraseRazorpayCustomerPii: (id: string, userId: string) =>
    erasePii(id, userId),
}));
jest.mock("../../lib/payments/payouts/razorpay-payouts", () => ({
  getRazorpayPayoutsService: () => vendor,
}));

import { scrubUser } from "@/lib/compliance/erasure/scrub-user";

// Every model answers every call with an empty result unless overridden.
function models(overrides: Record<string, unknown>) {
  return new Proxy(overrides, {
    get: (target, model: string) =>
      target[model] ??
      new Proxy({}, { get: () => jest.fn(async () => ({ count: 0 })) }),
  });
}

const payoutAccountUpdate = jest.fn(async () => ({ count: 1 }));
const userUpdate = jest.fn(async () => ({}));
const tx = models({
  payoutAccount: { updateMany: payoutAccountUpdate },
  collaborator: { updateManyAndReturn: jest.fn(async () => []) },
  erasureRequest: { findFirst: jest.fn(async () => null) },
});
const db = models({
  user: {
    findUnique: jest.fn(async () => ({
      id: "u1",
      erasedAt: null,
      pseudonymousId: null,
      razorpayCustomerId: "cust_1",
    })),
    update: userUpdate,
  },
  membership: { findMany: jest.fn(async () => []) },
  payoutAccount: {
    findMany: jest.fn(async () => [
      { id: "pa1", razorpayContactId: "cont_1", razorpayFundAccId: "fa_1" },
    ]),
  },
  $transaction: jest.fn(async (fn: (t: unknown) => unknown) => fn(tx)),
});

it("off-boards the payment vendors and keeps only references", async () => {
  const result = await scrubUser(db as never, "u1");

  expect(vendor.deleteTokens).toHaveBeenCalledWith("cust_1");
  expect(erasePii).toHaveBeenCalledWith("cust_1", "u1");
  expect(erasePii.mock.invocationCallOrder[0]).toBeGreaterThan(
    vendor.deleteTokens.mock.invocationCallOrder[0],
  );
  expect(erasePii.mock.invocationCallOrder[0]).toBeLessThan(
    userUpdate.mock.invocationCallOrder[0],
  );
  expect(vendor.deactivateFundAccount).toHaveBeenCalledWith("fa_1");
  expect(vendor.deactivateContact).toHaveBeenCalledWith("cont_1");
  expect(userUpdate).toHaveBeenCalledWith({
    where: { id: "u1" },
    data: { razorpayCustomerId: null },
  });
  const { data } = (
    payoutAccountUpdate.mock.calls as unknown as [{ data: object }][]
  )[0][0];
  expect(data).toEqual({
    accountHolderName: null,
    bankName: null,
    accountNumberLast4: null,
    ifscCode: null,
    upiId: null,
  });
  expect(data).not.toHaveProperty("razorpayFundAccId");
  expect(result.vendorFailures).toEqual([]);
});
