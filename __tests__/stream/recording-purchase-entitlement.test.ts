/**
 * @jest-environment node
 */

/**
 * D6 — the replay marketplace had no amount check and no way to take an
 * entitlement back.
 *
 * A `recording_purchase` is the one sale on this platform that hands the buyer a
 * DURABLE artefact — permanent replay access to a session recording — and it is
 * the only money path that is not a `Payment` row. That has two consequences
 * the B2C pipeline never has to think about:
 *
 *   - nothing downstream reconciles it. There is no earnings leg, no invoice, no
 *     `applyRefundCascade` to notice a discrepancy, so whatever the capture says
 *     is what the buyer gets, permanently.
 *   - `handleRecordingPurchaseSuccess` ignored the captured amount entirely, so a
 *     partial (or tampered) capture flipped the row to SUCCEEDED and granted
 *     that entitlement for a fraction of the list price.
 *
 * And in the other direction, `RecordingPurchaseStatus.REFUNDED` had ZERO writers
 * anywhere in the repo while the entitlement check in
 * `app/api/stream/recordings/[recordingId]` reads `status: "SUCCEEDED"` and
 * nothing else. A refunded buyer therefore kept VOD access forever. The
 * alternative on the table was deleting the enum value, which needs a schema
 * migration this bucket does not own and — more to the point — would have
 * documented the access bug away instead of fixing it. So it is wired.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

const mockFindUnique = jest.fn();
const mockUpdateMany = jest.fn();
const mockCaptureMessage = jest.fn();

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    recordingPurchase: {
      findUnique: (...a: unknown[]) => mockFindUnique(...a),
      updateMany: (...a: unknown[]) => mockUpdateMany(...a),
    },
  },
}));
jest.mock("@sentry/nextjs", () => ({
  captureMessage: (...a: unknown[]) => mockCaptureMessage(...a),
  captureException: jest.fn(),
  logger: { info: jest.fn() },
}));

import {
  handleRecordingPurchaseRefund,
  handleRecordingPurchaseSuccess,
} from "../../lib/payments/webhooks/recording-purchase";

/**
 * A settled-but-unclaimed purchase at the list price of ₹499.00.
 *
 * `amountPaise` is a NUMBER, not a BigInt: the column is BigInt and
 * `lib/prisma-extensions.ts` (#780) converts every BigInt column to a number on
 * read so no bigint ever reaches JSON or a gateway payload. A test that used
 * `49900n` would be asserting a shape the client never returns.
 */
const purchase = (over: Record<string, unknown> = {}) => ({
  id: "rp_1",
  status: "PENDING",
  amountPaise: 49900,
  ...over,
});

beforeEach(() => {
  mockFindUnique.mockReset();
  mockUpdateMany.mockReset();
  mockUpdateMany.mockResolvedValue({ count: 1 });
  mockCaptureMessage.mockReset();
  jest.spyOn(console, "error").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("capture amount parity", () => {
  it("settles when the captured amount matches the order", async () => {
    mockFindUnique.mockResolvedValue(purchase());

    await handleRecordingPurchaseSuccess("order_1", "pay_1", 49900);

    expect(mockUpdateMany).toHaveBeenCalledWith({
      where: { id: "rp_1", status: "PENDING" },
      data: { status: "SUCCEEDED", gatewayPaymentId: "pay_1" },
    });
  });

  it("REFUSES a partial capture — no entitlement, no page swallowed", async () => {
    mockFindUnique.mockResolvedValue(purchase());

    await handleRecordingPurchaseSuccess("order_1", "pay_1", 100);

    expect(mockUpdateMany).not.toHaveBeenCalled();
    // An error, not a warning: this is a money event that needs a human.
    expect(mockCaptureMessage).toHaveBeenCalledWith(
      expect.stringContaining("capture amount does not match"),
      expect.objectContaining({ level: "error" }),
    );
  });

  it("refuses an OVER-capture too, rather than crediting the difference", async () => {
    mockFindUnique.mockResolvedValue(purchase());

    await handleRecordingPurchaseSuccess("order_1", "pay_1", 99900);

    expect(mockUpdateMany).not.toHaveBeenCalled();
  });

  it("settles when no amount is available to check (order.paid without a payment entity)", async () => {
    // The org path already established this rule: on `order.paid` the figure can
    // be the order total rather than what settled, and passing it could mark an
    // invoice paid on a partial payment. Undefined means "cannot check", and
    // refusing here would strand every replay sale delivered over that route.
    mockFindUnique.mockResolvedValue(purchase());

    await handleRecordingPurchaseSuccess("order_1", undefined, undefined);

    expect(mockUpdateMany).toHaveBeenCalledWith({
      where: { id: "rp_1", status: "PENDING" },
      data: { status: "SUCCEEDED" },
    });
  });

  it("is a no-op on an already-settled replay, and does not re-read or re-write", async () => {
    mockFindUnique.mockResolvedValue(purchase({ status: "SUCCEEDED" }));

    await handleRecordingPurchaseSuccess("order_1", "pay_1", 1);

    expect(mockUpdateMany).not.toHaveBeenCalled();
  });

  it("settles conditionally on PENDING, so two concurrent deliveries cannot both stamp", async () => {
    mockFindUnique.mockResolvedValue(purchase());
    mockUpdateMany.mockResolvedValue({ count: 0 });

    await handleRecordingPurchaseSuccess("order_1", "pay_1", 49900);

    // The webhook and the stuck-event sweeper both re-drive the same capture;
    // only the first may write.
    expect(mockUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "rp_1", status: "PENDING" } }),
    );
  });
});

describe("refund revokes the entitlement", () => {
  it("flips SUCCEEDED to REFUNDED on a full processed refund", async () => {
    mockFindUnique.mockResolvedValue(purchase({ status: "SUCCEEDED" }));

    const handled = await handleRecordingPurchaseRefund({
      orderId: "order_1",
      status: "processed",
      amountPaise: 49900,
    });

    expect(handled).toBe(true);
    // #1829 — the filter covers BOTH live states, not just the settled one.
    //
    // Razorpay can deliver `refund.processed` before `payment.captured`. With a
    // SUCCEEDED-only filter the CAS matched zero rows on a still-PENDING row, the
    // function returned `true` all the same (which the dispatcher reads as
    // "handled, do not cascade"), the event was marked processed, and the later
    // capture settled the row to SUCCEEDED — permanent replay access after a full
    // refund, with nothing having errored.
    expect(mockUpdateMany).toHaveBeenCalledWith({
      where: { id: "rp_1", status: { in: ["SUCCEEDED", "PENDING"] } },
      data: { status: "REFUNDED" },
    });
  });

  it("revokes a PENDING row, so a later capture cannot settle it", async () => {
    // The ordering the CAS above exists for. The settle path is itself
    // conditional on `status: "PENDING"`, so marking the row REFUNDED first makes
    // the capture a no-op rather than a grant — both orderings converge instead
    // of one winning by arrival time.
    mockFindUnique.mockResolvedValue(purchase({ status: "PENDING" }));

    const handled = await handleRecordingPurchaseRefund({
      orderId: "order_1",
      status: "processed",
      amountPaise: 49900,
    });

    expect(handled).toBe(true);
    expect(mockUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "rp_1", status: { in: ["SUCCEEDED", "PENDING"] } },
        data: { status: "REFUNDED" },
      }),
    );
  });

  it("leaves an already-terminal row alone and still reports handled", async () => {
    mockFindUnique.mockResolvedValue(purchase({ status: "REFUNDED" }));
    mockUpdateMany.mockResolvedValue({ count: 0 });

    const handled = await handleRecordingPurchaseRefund({
      orderId: "order_1",
      status: "processed",
      amountPaise: 49900,
    });

    // A duplicate refund is not a failure, and returning false here would send
    // the dispatcher into the B2C refund cascade, which would find no Payment and
    // defer until the 168h give-up cap for a refund already handled.
    expect(handled).toBe(true);
  });

  it("leaves the entitlement alone on a PARTIAL refund, and says so", async () => {
    mockFindUnique.mockResolvedValue(purchase({ status: "SUCCEEDED" }));

    const handled = await handleRecordingPurchaseRefund({
      orderId: "order_1",
      status: "processed",
      amountPaise: 1000,
    });

    expect(handled).toBe(true);
    expect(mockUpdateMany).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("partial refund"),
    );
  });

  it("does nothing on a pending or failed refund", async () => {
    mockFindUnique.mockResolvedValue(purchase({ status: "SUCCEEDED" }));

    await handleRecordingPurchaseRefund({
      orderId: "order_1",
      status: "pending",
      amountPaise: 49900,
    });

    expect(mockUpdateMany).not.toHaveBeenCalled();
  });

  it("claims the event even when it changes nothing, so the B2C cascade does not defer forever", async () => {
    // A replay order has no `Payment`, no `WalletTopUp` and no
    // `OrganizationInvoice`. `handleRefundCreated` matches none of them and, on
    // Razorpay, returns a DeferSignal — which parks the event unprocessed for
    // the sweeper to re-drive until the 168-hour give-up cap, for a refund that
    // was fully handled right here.
    mockFindUnique.mockResolvedValue(purchase({ status: "SUCCEEDED" }));

    await expect(
      handleRecordingPurchaseRefund({
        orderId: "order_1",
        status: "failed",
        amountPaise: 49900,
      }),
    ).resolves.toBe(true);
  });

  it("returns false for a refund that is not a replay purchase, so the normal cascade runs", async () => {
    mockFindUnique.mockResolvedValue(null);

    await expect(
      handleRecordingPurchaseRefund({
        orderId: "order_appt",
        status: "processed",
        amountPaise: 49900,
      }),
    ).resolves.toBe(false);
  });
});

describe("the entitlement check downstream", () => {
  it("gates playback on SUCCEEDED alone, so REFUNDED is what revokes it", () => {
    const src = readFileSync(
      join(__dirname, "../../app/api/stream/recordings/[recordingId]/route.ts"),
      "utf8",
    );
    // A single source of truth for the entitlement. If this ever widens (say to
    // `status: { in: [...] }`) the refund flip stops being a revocation and the
    // D6 gap reopens silently.
    expect(src).toContain(
      'where: { recordingId, buyerId: userId, status: "SUCCEEDED" }',
    );
  });
});
