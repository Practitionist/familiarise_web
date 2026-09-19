/**
 * @jest-environment node
 */

/**
 * #1477 — `POST /api/checkout` captured every error that reached its generic
 * tail as a Sentry exception, before it had even been classified. Only the
 * refusals with an explicit `instanceof` branch above that line escaped it, so
 * the #1458 programme-cap codes and the #1467 entitlement codes answered the
 * buyer correctly and still opened an incident on every routine refusal.
 *
 * The route's collaborators are boundary-mocked: what is under test is which
 * report a coded refusal gets on its way out of the catch, not auth, rate
 * limiting, tax context or gateway routing.
 */

jest.mock("../../lib/auth-helpers", () => ({
  requireApiAuth: jest.fn(async () => ({
    session: { user: { id: "user_1" } },
  })),
}));

jest.mock("../../lib/rate-limit", () => ({
  __esModule: true,
  applyRateLimit: jest.fn(async () => null),
  checkoutLimiter: { limit: jest.fn() },
}));

const handleCheckout = jest.fn();
jest.mock("../../lib/payments/operations/checkout", () => ({
  handleCheckout: (...args: unknown[]) => handleCheckout(...args),
}));

jest.mock("../../lib/payments/operations/checkout-replay", () => ({
  replayByIdempotencyKey: jest.fn(async () => null),
}));

jest.mock("../../lib/payments/tax/checkout-context", () => ({
  resolveCheckoutTaxContext: jest.fn(async () => ({ buyerCountry: "IN" })),
}));

jest.mock("../../lib/payments/gateway-router", () => ({
  routeGateway: jest.fn(() => ({ gateway: "RAZORPAY", reason: "domestic" })),
}));

// The schema is a boundary here: the body only has to survive parsing so the
// handler can reach `handleCheckout` and throw.
jest.mock("../../schemas/checkout", () => ({
  checkoutSchema: { parse: (body: Record<string, unknown>) => ({ ...body }) },
}));

const captureException = jest.fn();
jest.mock("@sentry/nextjs", () => ({
  captureException: (...args: unknown[]) => captureException(...args),
  captureMessage: jest.fn(),
}));

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {},
}));

import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";

import { POST } from "../../app/api/checkout/route";
import { getErrorToast } from "../../lib/errors/mapping/payment-error-toast-map";
import { replayByIdempotencyKey } from "../../lib/payments/operations/checkout-replay";

function checkoutRequest(body: Record<string, unknown> = {}) {
  return new NextRequest("https://x.test/api/checkout", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ appointmentId: "appt_1", amount: 100, ...body }),
  });
}

/** The context Sentry was handed, for the single capture the route made. */
function soleCaptureContext(): {
  level?: string;
  tags?: Record<string, string>;
} {
  expect(captureException).toHaveBeenCalledTimes(1);
  return (captureException.mock.calls[0]?.[1] ?? {}) as {
    level?: string;
    tags?: Record<string, string>;
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "warn").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("a business-coded refusal leaves POST /api/checkout as an answer", () => {
  it("answers PROGRAM_ASSIGNMENT_INACTIVE 409 without an error-level capture", async () => {
    handleCheckout.mockRejectedValue(
      Object.assign(
        new Error("No active programme assignment covers this session type"),
        { code: "PROGRAM_ASSIGNMENT_INACTIVE" },
      ),
    );

    const res = await POST(checkoutRequest());
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.errorType).toBe("PROGRAM_ASSIGNMENT_INACTIVE_ERROR");

    // Reported, but as a modelled outcome: `expected` tagged true and the level
    // pinned to info. An error-level capture is exactly what paged us.
    const context = soleCaptureContext();
    expect(context.level).toBe("info");
    expect(context.tags?.expected).toBe("true");
  });

  // #1757 — "Webinar is full" was a bare Error; the prose classifier answered
  // the buyer but checkout's outer catch paged it as a fault (FAMILIARISE_WEB-2J).
  it("answers EVENT_FULL 409 as a modelled outcome, and the toast copy points at the way out", async () => {
    handleCheckout.mockRejectedValue(
      Object.assign(new Error("Webinar is full"), {
        httpStatus: 409,
        code: "EVENT_FULL",
      }),
    );

    const res = await POST(checkoutRequest());
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.errorType).toBe("EVENT_FULL_ERROR");
    const context = soleCaptureContext();
    expect(context.level).toBe("info");
    expect(context.tags?.expected).toBe("true");
    expect(getErrorToast("EVENT_FULL_ERROR").description).toContain(
      "join the waitlist",
    );
  });

  it("still captures an unrecognised failure at Sentry's default level", async () => {
    handleCheckout.mockRejectedValue(new Error("connection terminated"));

    const res = await POST(checkoutRequest());

    expect(res.status).toBe(500);
    // Two captures here (the route's own, then logClassifiedError's). Asserted
    // rather than assumed, so the loop below cannot pass on an empty list; the
    // point of the loop is that neither is downgraded to a modelled outcome.
    expect(captureException).toHaveBeenCalledTimes(2);
    for (const call of captureException.mock.calls) {
      const context = (call[1] ?? {}) as {
        level?: string;
        tags?: Record<string, string>;
      };
      expect(context.level).toBeUndefined();
      expect(context.tags?.expected).not.toBe("true");
    }
  });
});

// #1582 B-P1-01b/c, #1564, #1586 J32 — the refusals that were still bare
// Errors (500 UNKNOWN + a Sentry fault each) now carry registered codes.
describe("every newly typed refusal answers its own status, tagged expected", () => {
  const cases: Array<[string, number, string]> = [
    ["ORG_NOT_OPERATIONAL", 403, "ORG_NOT_OPERATIONAL_ERROR"],
    ["ORG_CANNOT_SPONSOR", 403, "ORG_CANNOT_SPONSOR_ERROR"],
    ["ORG_MEMBERSHIP_REQUIRED", 403, "ORG_MEMBERSHIP_REQUIRED_ERROR"],
    ["ORG_CREDIT_LIMIT_REACHED", 402, "ORG_CREDIT_LIMIT_REACHED_ERROR"],
    ["CONSULTANT_NOT_ON_PANEL", 409, "CONSULTANT_NOT_ON_PANEL_ERROR"],
    [
      "CONSULTANT_EXCLUSIVE_ENGAGEMENT",
      409,
      "CONSULTANT_EXCLUSIVE_ENGAGEMENT_ERROR",
    ],
    ["CURRENCY_UNSUPPORTED", 422, "CURRENCY_UNSUPPORTED_ERROR"],
    ["NON_INR_SETTLEMENT", 422, "CURRENCY_UNSUPPORTED_ERROR"],
    ["CREDIT_SHORTFALL", 409, "CREDIT_SHORTFALL_ERROR"],
    ["DISCOUNT_CURRENCY_MISMATCH", 400, "DISCOUNT_CURRENCY_MISMATCH_ERROR"],
  ];

  it.each(cases)("%s → %i %s", async (code, httpStatus, errorType) => {
    handleCheckout.mockRejectedValue(
      Object.assign(new Error(`internal detail for ${code}`), {
        code,
        httpStatus,
      }),
    );

    const res = await POST(checkoutRequest());
    const body = await res.json();

    expect(res.status).toBe(httpStatus);
    expect(body.errorType).toBe(errorType);
    // The registered userMessage replaces the thrown (internal) message.
    expect(body.error).not.toContain("internal detail");
    const context = soleCaptureContext();
    expect(context.level).toBe("info");
    expect(context.tags?.expected).toBe("true");
  });
});

// #1583 C-P1-04 — two concurrent same-key checkouts: the loser's Payment
// create dies on the clientIdempotencyKey unique. The route has always had a
// replay branch for that P2002, but handleCheckout rewrapped the Prisma error
// into a generic one so the branch never fired and the loser answered 500.
describe("a same-key P2002 out of handleCheckout replays the winner", () => {
  it("the loser of two same-key requests answers the winner's response instead of a 500", async () => {
    const KEY = "same-key-both-tabs";
    const winnerBody = { success: true, paymentId: "pay_w" };
    // Request A wins the unique; request B's create dies on it.
    handleCheckout.mockResolvedValueOnce(winnerBody).mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError("unique", {
        code: "P2002",
        clientVersion: "test",
        meta: { target: ["userId", "clientIdempotencyKey"] },
      }),
    );
    (replayByIdempotencyKey as jest.Mock)
      .mockResolvedValueOnce(null) // A's fast path: nothing recorded yet
      .mockResolvedValueOnce(null) // B's fast path: A has not committed yet
      .mockResolvedValueOnce(NextResponse.json(winnerBody)); // B's catch

    const [winner, loser] = await Promise.all([
      POST(checkoutRequest({ clientIdempotencyKey: KEY })),
      POST(checkoutRequest({ clientIdempotencyKey: KEY })),
    ]);

    expect(winner.status).toBe(200);
    expect(loser.status).toBe(200);
    expect(await loser.json()).toEqual(winnerBody);
    // Every replay lookup — both fast paths and the loser's catch — is keyed
    // by the one key both tabs sent, never a server-minted one.
    expect(replayByIdempotencyKey).toHaveBeenCalledTimes(3);
    for (const call of (replayByIdempotencyKey as jest.Mock).mock.calls) {
      expect(call).toEqual(["user_1", KEY]);
    }
  });
});
