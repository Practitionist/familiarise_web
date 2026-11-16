/**
 * @jest-environment node
 */

/**
 * The trial-price floor PATCH is an audited door: a reason is required, the
 * write is CAS on the floor it read, and one `trialPricing.update` row records
 * the floor before and after, in paise.
 */

import { NextRequest } from "next/server";

jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));
jest.mock("../../lib/observability/report", () => ({
  reportSentryError: jest.fn(),
}));
jest.mock("../../lib/api/after-safe", () => ({ scheduleAfter: jest.fn() }));
jest.mock("../../lib/auth-helpers", () => ({
  requireBackofficeSurface: async () => ({
    session: { user: { id: "admin-1", role: "ADMIN" } },
  }),
}));

const mockConfig = {
  upsert: jest.fn(),
  updateMany: jest.fn(),
};
const mockOpsLog = { create: jest.fn(async () => ({ id: "ops-row" })) };
jest.mock("../../lib/prisma", () => {
  const tx = {
    get platformPricingConfig() {
      return mockConfig;
    },
    get opsActionLog() {
      return mockOpsLog;
    },
  };
  return {
    __esModule: true,
    default: {
      $transaction: (run: (t: unknown) => Promise<unknown>) => run(tx),
    },
  };
});

import { PATCH } from "../../app/api/admin/trial-pricing/route";

const patch = (body: Record<string, unknown>) =>
  PATCH(
    new NextRequest("http://test/api/admin/trial-pricing", {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({}) },
  );
const reason = "Raise the floor for launch";

beforeEach(() => {
  jest.clearAllMocks();
  mockConfig.upsert.mockResolvedValue({ minTrialPriceInPaise: 4_900 });
  mockConfig.updateMany.mockResolvedValue({ count: 1 });
});

it("sets the floor by CAS and records it before and after in paise", async () => {
  const res = await patch({ minTrialPriceInPaise: 9_900, reason });
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ minTrialPriceInPaise: 9_900 });
  expect(mockConfig.updateMany).toHaveBeenCalledWith({
    where: { id: "singleton", minTrialPriceInPaise: 4_900 },
    data: { minTrialPriceInPaise: 9_900 },
  });
  expect(mockOpsLog.create).toHaveBeenCalledTimes(1);
  expect(mockOpsLog.create).toHaveBeenCalledWith(
    expect.objectContaining({
      data: expect.objectContaining({
        actorUserId: "admin-1",
        actorRole: "ADMIN",
        surface: "trialPricing.manage",
        action: "trialPricing.update",
        targetKind: "PlatformPricingConfig",
        targetId: "singleton",
        reason,
        before: { minTrialPriceInPaise: 4_900 },
        after: { minTrialPriceInPaise: 9_900 },
      }),
    }),
  );
});

it("refuses without a reason and writes nothing", async () => {
  const res = await patch({ minTrialPriceInPaise: 9_900 });
  expect(res.status).toBe(400);
  expect((await res.json()).error).toBe(
    "Give a reason of at least 5 characters.",
  );
  expect(mockConfig.updateMany).not.toHaveBeenCalled();
  expect(mockOpsLog.create).not.toHaveBeenCalled();
});

it("refuses a negative or fractional floor", async () => {
  expect((await patch({ minTrialPriceInPaise: -1, reason })).status).toBe(400);
  expect((await patch({ minTrialPriceInPaise: 10.5, reason })).status).toBe(
    400,
  );
  expect(mockConfig.updateMany).not.toHaveBeenCalled();
});

it("409 FLOOR_CHANGED when another admin moved the floor first", async () => {
  mockConfig.updateMany.mockResolvedValue({ count: 0 });
  const res = await patch({ minTrialPriceInPaise: 9_900, reason });
  expect(res.status).toBe(409);
  expect((await res.json()).code).toBe("FLOOR_CHANGED");
  expect(mockOpsLog.create).not.toHaveBeenCalled();
});

it("409 FLOOR_UNCHANGED with no write and no audit row for the current value", async () => {
  const res = await patch({ minTrialPriceInPaise: 4_900, reason });
  expect(res.status).toBe(409);
  expect(await res.json()).toMatchObject({
    code: "FLOOR_UNCHANGED",
    minTrialPriceInPaise: 4_900,
  });
  expect(mockConfig.updateMany).not.toHaveBeenCalled();
  expect(mockOpsLog.create).not.toHaveBeenCalled();
});

it("a retried change after it landed records nothing more", async () => {
  expect((await patch({ minTrialPriceInPaise: 9_900, reason })).status).toBe(
    200,
  );
  expect(mockOpsLog.create).toHaveBeenCalledTimes(1);
  // The floor now reads the value the first request set.
  mockConfig.upsert.mockResolvedValue({ minTrialPriceInPaise: 9_900 });
  const retry = await patch({ minTrialPriceInPaise: 9_900, reason });
  expect(retry.status).toBe(409);
  expect((await retry.json()).code).toBe("FLOOR_UNCHANGED");
  expect(mockConfig.updateMany).toHaveBeenCalledTimes(1);
  expect(mockOpsLog.create).toHaveBeenCalledTimes(1);
});
