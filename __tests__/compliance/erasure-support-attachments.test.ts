/**
 * @jest-environment node
 */

// Support evidence files are deleted after the scrub commits. A storage
// failure there must become a retriable vendor failure, never a thrown error
// that skips the Novu off-boarding and outbox settlement that follow.

jest.mock("../../lib/documents/document-erasure", () => ({
  eraseUserSessionDocuments: jest.fn(async () => []),
}));
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
jest.mock("../../lib/novu/client", () => ({
  isNovuConfigured: () => true,
  getNovuClient: () => ({}),
}));
const reportSentryError = jest.fn(() => "evt");
jest.mock("../../lib/observability/report", () => ({
  ...jest.requireActual("../../lib/observability/report"),
  reportSentryError: (...args: unknown[]) => reportSentryError(...args),
}));
const removeObjects = jest.fn(
  async (_bucket: string, _paths: string[]) => true,
);
jest.mock("../../lib/supabase-storage-core", () => ({
  __esModule: true,
  removeObjects: (bucket: string, paths: string[]) =>
    removeObjects(bucket, paths),
}));

import { scrubUser } from "@/lib/compliance/erasure/scrub-user";
import { removeSupportAttachmentObjects } from "@/lib/support/erasure";
import { supportScrubModels } from "../fixtures/support-erasure-models";

const PATH = "support-cases/c1/evidence/e1/f1.pdf";

function models(overrides: Record<string, unknown>) {
  return new Proxy(overrides, {
    get: (target, model: string) =>
      target[model] ??
      new Proxy({}, { get: () => jest.fn(async () => ({ count: 0 })) }),
  });
}

function withAttachment(findMany: jest.Mock) {
  const base = supportScrubModels();
  return {
    ...base,
    supportCaseAttachment: { ...base.supportCaseAttachment, findMany },
  };
}

function makeDb({
  erased = false,
  attachments = jest.fn(async () => [{ storagePath: PATH }]),
}: { erased?: boolean; attachments?: jest.Mock } = {}) {
  const tx = models({
    ...withAttachment(attachments),
    collaborator: { updateManyAndReturn: jest.fn(async () => []) },
    erasureRequest: { findFirst: jest.fn(async () => null) },
  });
  return models({
    ...withAttachment(attachments),
    user: {
      findUnique: jest.fn(async () => ({
        id: "u1",
        erasedAt: erased ? new Date() : null,
        pseudonymousId: erased ? "pseudo1234abcd" : null,
        razorpayCustomerId: null,
      })),
      update: jest.fn(async () => ({})),
    },
    membership: { findMany: jest.fn(async () => []) },
    payoutAccount: { findMany: jest.fn(async () => []) },
    erasureRequest: { findFirst: jest.fn(async () => null) },
    $transaction: jest.fn(async (fn: (t: unknown) => unknown) => fn(tx)),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  removeObjects.mockResolvedValue(true);
  deleteSubscriber.mockResolvedValue(true);
});

describe("removeSupportAttachmentObjects", () => {
  it("returns a re-run line instead of throwing when storage throws", async () => {
    removeObjects.mockRejectedValueOnce(new Error("storage down"));
    const failures = await removeSupportAttachmentObjects([PATH], "u1");
    expect(failures).toEqual([
      expect.stringMatching(/^support_attachments: 1 file\(s\).*re-run/),
    ]);
    expect(reportSentryError).toHaveBeenCalledTimes(1);
  });

  it("does nothing for an empty path list", async () => {
    await expect(removeSupportAttachmentObjects([], "u1")).resolves.toEqual([]);
    expect(removeObjects).not.toHaveBeenCalled();
  });
});

describe("support attachments on the erasure paths", () => {
  it("completes the first scrub and still off-boards Novu when storage throws", async () => {
    removeObjects.mockRejectedValue(new Error("storage down"));
    const result = await scrubUser(makeDb() as never, "u1");
    expect(result.scrubbed).toBe(true);
    expect(result.vendorFailures).toEqual([
      expect.stringMatching(/^support_attachments:/),
    ]);
    expect(deleteSubscriber).toHaveBeenCalledWith("u1");
  });

  it("retries the file delete when an erased user is scrubbed again", async () => {
    const result = await scrubUser(makeDb({ erased: true }) as never, "u1");
    expect(result.scrubbed).toBe(false);
    expect(removeObjects).toHaveBeenCalledWith("support-attachments", [PATH]);
    expect(result.vendorFailures).toEqual([]);
  });

  it("reports, not throws, when the retry cannot list the files", async () => {
    const attachments = jest.fn(async () => {
      throw new Error("db down");
    });
    const result = await scrubUser(
      makeDb({ erased: true, attachments }) as never,
      "u1",
    );
    expect(result.vendorFailures).toEqual([
      expect.stringMatching(/support-attachments: storage cleanup failed/),
    ]);
    expect(deleteSubscriber).toHaveBeenCalledWith("u1");
  });

  it("reports, not throws, when the retry's storage delete throws", async () => {
    removeObjects.mockRejectedValue(new Error("storage down"));
    const result = await scrubUser(makeDb({ erased: true }) as never, "u1");
    expect(result.vendorFailures).toEqual([
      expect.stringMatching(/^support_attachments:/),
    ]);
  });
});
