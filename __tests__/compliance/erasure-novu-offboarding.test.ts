/**
 * @jest-environment node
 */

/**
 * `DELETE /api/user/[id]` has always called `deleteSubscriber` on both of its
 * branches. The ADMIN path — `POST /api/admin/erasure-requests/[id]/process` →
 * `scrubUser` — never did, so an erasure carried out by an operator left a live
 * Novu subscriber holding the user's email address and push tokens, for a user
 * who had explicitly asked to be erased.
 *
 * `deleteSubscriber` never throws: it resolves `true` on success and when Novu
 * is not configured, and `false` when the remote delete did not happen. So
 * `false` is the only signal, and it has to surface as a retriable entry in
 * `vendorFailures` rather than passing silently.
 */

jest.mock("../../lib/enterprise/outbound-webhooks/dispatch", () => ({
  dispatchWebhookEvent: jest.fn(),
}));
jest.mock("../../lib/enterprise/system-events", () => ({
  recordSystemErrorSafe: jest.fn(async () => undefined),
}));
jest.mock("../../lib/payments/core/razorpay", () => ({
  deleteRazorpayCustomerTokens: jest.fn(async () => 0),
  eraseRazorpayCustomerPii: jest.fn(async () => {}),
}));
jest.mock("../../lib/payments/payouts/razorpay-payouts", () => ({
  getRazorpayPayoutsService: () => ({
    deactivateFundAccount: jest.fn(async () => ({})),
    deactivateContact: jest.fn(async () => ({})),
  }),
}));

const deleteSubscriber = jest.fn(async (_userId: string) => true);
jest.mock("../../lib/novu/subscriber", () => ({
  deleteSubscriber: (id: string) => deleteSubscriber(id),
}));

import { scrubUser } from "@/lib/compliance/erasure/scrub-user";

function models(overrides: Record<string, unknown>) {
  return new Proxy(overrides, {
    get: (target, model: string) =>
      target[model] ??
      new Proxy({}, { get: () => jest.fn(async () => ({ count: 0 })) }),
  });
}

const tx = models({
  collaborator: { updateManyAndReturn: jest.fn(async () => []) },
  erasureRequest: { findFirst: jest.fn(async () => null) },
});

function makeDb() {
  return models({
    user: {
      findUnique: jest.fn(async () => ({
        id: "u1",
        erasedAt: null,
        pseudonymousId: null,
        razorpayCustomerId: null,
      })),
      update: jest.fn(async () => ({})),
    },
    membership: { findMany: jest.fn(async () => []) },
    payoutAccount: { findMany: jest.fn(async () => []) },
    $transaction: jest.fn(async (fn: (t: unknown) => unknown) => fn(tx)),
  });
}

beforeEach(() => {
  deleteSubscriber.mockClear();
  deleteSubscriber.mockResolvedValue(true);
});

describe("Novu off-boarding on the admin erasure path", () => {
  it("deletes the Novu subscriber", async () => {
    await scrubUser(makeDb() as never, "u1");
    expect(deleteSubscriber).toHaveBeenCalledWith("u1");
  });

  it("reports an unconfirmed remote delete as a retriable vendor failure", async () => {
    // deleteSubscriber resolves false rather than throwing, so a try/catch
    // alone would swallow this entirely.
    deleteSubscriber.mockResolvedValue(false);
    const result = await scrubUser(makeDb() as never, "u1");
    expect(result.vendorFailures).toHaveLength(1);
    expect(result.vendorFailures[0]).toMatch(/novu/i);
  });

  it("does not report a failure when Novu is not configured", async () => {
    // `deleteSubscriber` resolves TRUE in that case: nothing was mirrored, so
    // there is nothing to clean up and nothing to retry.
    deleteSubscriber.mockResolvedValue(true);
    const result = await scrubUser(makeDb() as never, "u1");
    expect(result.vendorFailures).toEqual([]);
  });

  it("still completes the scrub when the Novu delete is unconfirmed", async () => {
    // The pseudonymous user row is already committed by the time we get here.
    // A vendor we could not reach is a retriable problem, not a reason to fail
    // a completed erasure.
    deleteSubscriber.mockResolvedValue(false);
    const result = await scrubUser(makeDb() as never, "u1");
    expect(result.scrubbed).toBe(true);
    expect(result.pseudonymousId).toEqual(expect.any(String));
  });
});
