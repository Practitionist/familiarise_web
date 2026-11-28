/**
 * @jest-environment node
 */

/**
 * The two account-wide list reads the discovery passes page through. The SDK
 * is mocked at its constructor, so these pin the request each wrapper sends
 * and the entity it accepts; neither is a statement about the live gateway.
 */

process.env.RAZORPAY_KEY_ID = "rzp_test_key";
process.env.RAZORPAY_SECRET = "rzp_test_secret";

const rzp = {
  refundsAll: jest.fn(),
  disputesAll: jest.fn(),
};

jest.mock("razorpay", () => {
  return jest.fn().mockImplementation(() => ({
    refunds: { all: (...a: unknown[]) => rzp.refundsAll(...a) },
    disputes: { all: (...a: unknown[]) => rzp.disputesAll(...a) },
  }));
});

import { listRazorpayRefundsCreatedBetween } from "@/lib/payments/core/razorpay";
import { listRazorpayDisputes } from "@/lib/payments/core/razorpay-disputes";

const listedRefund = {
  id: "rfnd_1",
  entity: "refund",
  payment_id: "pay_1",
  amount: 50_000,
  currency: "INR",
  status: "processed",
  notes: { reservationId: "res_1" },
  created_at: 1_700_000_100,
};

const listedDispute = {
  id: "disp_1",
  entity: "dispute",
  payment_id: "pay_1",
  amount: 50_000,
  currency: "INR",
  amount_deducted: 50_000,
  reason_code: "chargeback",
  respond_by: 1_700_600_000,
  status: "lost",
  phase: "chargeback",
  created_at: 1_700_000_000,
};

beforeEach(() => {
  jest.clearAllMocks();
});

afterEach(() => {
  jest.useRealTimers();
});

describe("listRazorpayRefundsCreatedBetween", () => {
  it("asks for one page of the window and returns the listed refunds", async () => {
    rzp.refundsAll.mockResolvedValue({
      entity: "collection",
      count: 1,
      items: [listedRefund],
    });

    const page = await listRazorpayRefundsCreatedBetween(
      { from: 1_700_000_000, to: 1_700_003_600 },
      100,
      200,
    );

    expect(rzp.refundsAll).toHaveBeenCalledWith({
      from: 1_700_000_000,
      to: 1_700_003_600,
      count: 100,
      skip: 200,
    });
    expect(page).toEqual([
      {
        id: "rfnd_1",
        payment_id: "pay_1",
        amount: 50_000,
        currency: "INR",
        status: "processed",
        notes: { reservationId: "res_1" },
        created_at: 1_700_000_100,
      },
    ]);
  });

  it("rejects a page holding an item without a payment id", async () => {
    rzp.refundsAll.mockResolvedValue({
      items: [{ ...listedRefund, payment_id: undefined }],
    });

    await expect(
      listRazorpayRefundsCreatedBetween({ from: 1, to: 2 }, 100, 0),
    ).rejects.toThrow();
  });

  it("turns the SDK's plain error object into an Error that names the answer", async () => {
    rzp.refundsAll.mockRejectedValue({
      statusCode: 400,
      error: { code: "BAD_REQUEST_ERROR", description: "from is invalid" },
    });

    await expect(
      listRazorpayRefundsCreatedBetween({ from: 1, to: 2 }, 100, 0),
    ).rejects.toThrow("from is invalid");
  });

  it("gives up on a list call that never answers", async () => {
    jest.useFakeTimers();
    rzp.refundsAll.mockReturnValue(new Promise(() => undefined));

    const outcome = listRazorpayRefundsCreatedBetween(
      { from: 1, to: 2 },
      100,
      0,
    ).then(
      () => "answered",
      (error: unknown) => (error instanceof Error ? error.message : "other"),
    );
    await jest.advanceTimersByTimeAsync(30_000);
    expect(await outcome).toMatch(/refunds\.all timed out/);
  });
});

describe("listRazorpayDisputes", () => {
  it("pages by count and skip only and returns status, phase, deduction and payment id", async () => {
    rzp.disputesAll.mockResolvedValue({
      entity: "collection",
      count: 1,
      items: [listedDispute],
    });

    const page = await listRazorpayDisputes(100, 300);

    expect(rzp.disputesAll).toHaveBeenCalledWith({ count: 100, skip: 300 });
    expect(page).toEqual([
      {
        id: "disp_1",
        payment_id: "pay_1",
        amount: 50_000,
        currency: "INR",
        amount_deducted: 50_000,
        reason_code: "chargeback",
        respond_by: 1_700_600_000,
        status: "lost",
        phase: "chargeback",
      },
    ]);
  });

  it("rejects a page holding an item without a status", async () => {
    rzp.disputesAll.mockResolvedValue({
      items: [{ ...listedDispute, status: undefined }],
    });

    await expect(listRazorpayDisputes(100, 0)).rejects.toThrow();
  });

  it("turns the SDK's plain error object into an Error that names the answer", async () => {
    rzp.disputesAll.mockRejectedValue({
      statusCode: 401,
      error: {
        code: "BAD_REQUEST_ERROR",
        description: "Authentication failed",
      },
    });

    await expect(listRazorpayDisputes(100, 0)).rejects.toThrow(
      "Authentication failed",
    );
  });
});
