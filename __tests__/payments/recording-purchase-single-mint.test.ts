/**
 * @jest-environment node
 */

/**
 * #1584 P2-P0-02 — POST /api/recordings/[recordingId]/purchase mints at most
 * ONE Razorpay order per (recording, buyer). `RecordingPurchase` has no unique
 * on that pair, and the settle handler is idempotent per gatewayOrderId, so
 * two overlapping POSTs used to produce two payable orders and a double
 * charge with no refund path. The route now runs read → mint → create under
 * `lockRecordingPurchase`, re-reading the live PENDING row inside the lock.
 *
 * Redis is an in-memory SET NX so the real lock code runs; the second caller
 * waits out the lock and resumes the first caller's order.
 */

jest.mock("@sentry/nextjs", () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
  logger: { info: jest.fn(), fmt: (s: TemplateStringsArray) => s.join("") },
}));

// `var`: the hoisted jest.mock factory runs before `const` initialisers.
// eslint-disable-next-line no-var
var held: Map<string, string>;
jest.mock("../../lib/redis", () => {
  held = new Map<string, string>();
  return {
    __esModule: true,
    default: {
      set: async (key: string, value: string, opts?: { nx?: boolean }) => {
        if (opts?.nx && held.has(key)) return null;
        held.set(key, value);
        return "OK";
      },
      eval: async (_script: string, keys: string[], args: string[]) => {
        if (held.get(keys[0]) === args[0]) {
          held.delete(keys[0]);
          return 1;
        }
        return 0;
      },
    },
    withCircuitBreaker: (fn: () => unknown) => fn(),
    checkRedisHealth: async () => true,
  };
});

jest.mock("../../lib/auth-server", () => ({
  getSession: jest.fn(async () => ({
    user: { id: "buyer_1", consultantProfileId: null },
  })),
}));

jest.mock("../../lib/stream/recording-listing-access", () => ({
  loadOwnedListingRecording: jest.fn(async () => ({
    status: "ok",
    listingStatus: "PUBLISHED",
    listPricePaise: BigInt(49_900),
    recordingStatus: "AVAILABLE",
    storageType: "SUPABASE",
    plan: { plan: { consultantProfileId: "cp_owner" } },
  })),
  isDiscoverablePlanPlan: () => true,
}));
jest.mock("../../lib/stream/recording-storage", () => ({
  isDurablyOurs: () => true,
}));

let mintCount = 0;
const createRazorpayOrder = jest.fn(async () => {
  mintCount += 1;
  // Let the racing caller reach the lock while this mint is in flight.
  await new Promise((r) => setTimeout(r, 20));
  return { id: `order_${mintCount}`, amount: 49_900, currency: "INR" };
});
jest.mock("../../lib/payments/core/razorpay", () => ({
  createRazorpayOrder: (...a: unknown[]) => createRazorpayOrder(...(a as [])),
  cancelRazorpayOrder: jest.fn(),
}));

const rows: Array<{
  recordingId: string;
  buyerId: string;
  gatewayOrderId: string;
  amountPaise: bigint;
  status: string;
}> = [];
const purchaseCreate = jest.fn(async ({ data }: { data: (typeof rows)[0] }) => {
  rows.push(data);
  return data;
});
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    recordingPurchase: {
      findFirst: async ({
        where,
      }: {
        where: { recordingId: string; buyerId: string; status: string };
      }) =>
        rows.find(
          (r) =>
            r.recordingId === where.recordingId &&
            r.buyerId === where.buyerId &&
            r.status === where.status,
        ) ?? null,
      create: (...a: unknown[]) => purchaseCreate(...(a as [never])),
    },
  },
}));

import { NextRequest } from "next/server";
import { POST } from "../../app/api/recordings/[recordingId]/purchase/route";

function post() {
  return POST(
    new NextRequest("http://localhost/api/recordings/rec_1/purchase", {
      method: "POST",
    }),
    { params: Promise.resolve({ recordingId: "rec_1" }) },
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  held.clear();
  rows.length = 0;
  mintCount = 0;
});

describe("recording purchase single-mint (#1584 P2-P0-02)", () => {
  it("two overlapping POSTs mint one order: the second resumes it or is told to retry", async () => {
    const [a, b] = await Promise.all([post(), post()]);
    const winner = a.status === 201 ? a : b;
    const loser = winner === a ? b : a;

    // Exactly one payable order and one row, whatever the second caller saw.
    expect(createRazorpayOrder).toHaveBeenCalledTimes(1);
    expect(purchaseCreate).toHaveBeenCalledTimes(1);
    expect(rows).toHaveLength(1);

    expect(winner.status).toBe(201);
    // The loser retried past the 20 ms mint (the request-path retry budget is
    // far longer), then resumed the live PENDING order instead of minting.
    expect(loser.status).toBe(200);
    expect((await loser.json()).data.orderId).toBe("order_1");
    // The lock was released by both callers.
    expect(held.size).toBe(0);
  });
});
