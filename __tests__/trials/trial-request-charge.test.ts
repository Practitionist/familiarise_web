/**
 * @jest-environment node
 */

/**
 * The buyer picks the trial time at request. A paid trial holds it and the
 * order is minted against the appointment holding it after the commit; a free
 * trial is confirmed in the same transaction and mints nothing.
 */

const createIntent = jest.fn(async () => ({
  paymentIntentId: "order_1",
  paymentId: "pay_1",
  checkoutUrl: "order_1",
}));
jest.mock("../../lib/payments/operations/approval-payment", () => ({
  createApprovalPaymentIntent: (...a: unknown[]) => createIntent(...(a as [])),
}));
jest.mock("../../lib/trials/pay-link", () => ({
  persistTrialPayLink: jest.fn(async () => "/checkout/pay/pay_1"),
}));
jest.mock("../../lib/auth-helpers", () => ({
  requireApiAuth: async () => ({
    session: {
      user: { id: "u-buyer", role: "CONSULTEE", consulteeProfileId: "cp-b" },
    },
  }),
}));
const prepared = { bells: [], emails: { prepared: {}, screened: [] } };
const prepareNotices = jest.fn(async (..._args: unknown[]) => prepared);
const stageNotices = jest.fn(async (..._args: unknown[]) => ({
  bells: [],
  emails: [],
}));
jest.mock("../../lib/trials/schedule-notices", () => ({
  prepareTrialScheduledNotices: (...a: unknown[]) => prepareNotices(...a),
  stageTrialScheduledNotices: (...a: unknown[]) => stageNotices(...a),
}));
jest.mock("../../lib/novu/stage-then-attempt", () =>
  jest
    .requireActual("../fixtures/trial-request-mocks")
    .flushNotificationsModule(),
);
jest.mock("../../utils/appointmentlock", () =>
  jest.requireActual("../fixtures/trial-request-mocks").requestCapLockModule(),
);
const release = jest.fn(async () => undefined);
const lockPick = jest.fn(async () => release);
const bookTrial = jest.fn(async (_tx: unknown, args: { paid: boolean }) => ({
  id: "trial-1",
  status: args.paid ? "AWAITING_PAYMENT" : "SCHEDULED",
  appointmentId: "apt-1",
  consulteeProfile: { user: { name: "B" } },
  consultantProfile: { user: { id: "u-expert", name: "E" } },
}));
class MockTrialDailyLimitError extends Error {
  constructor(readonly retryAt: Date) {
    super("You've reached today's trial request limit.");
  }
}
jest.mock("../../lib/trials/book-trial", () => ({
  lockTrialPick: (...a: unknown[]) => lockPick(...(a as [])),
  bookTrialInTx: (...a: unknown[]) =>
    bookTrial(...(a as [unknown, { paid: boolean }])),
  TrialTimeRefusedError: class extends Error {},
  TrialPairHeldError: class extends Error {},
  get TrialDailyLimitError() {
    return MockTrialDailyLimitError;
  },
}));

const plan = { trialPriceInPaise: 0, acceptingRequests: true };
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    trial: { findFirst: jest.fn(async () => null) },
    consultantProfile: { findUnique: jest.fn(async () => null) },
    subscriptionPlan: {
      findUnique: jest.fn(async () => ({
        id: "plan-1",
        title: "Mentorship",
        consultantProfileId: "cp-e",
        trialEnabled: true,
        trialDurationMinutes: 30,
        trialPriceInPaise: plan.trialPriceInPaise,
        visibility: "PUBLIC",
        organizationId: null,
        archivedAt: null,
        consultantProfile: {
          acceptingRequests: plan.acceptingRequests,
          verificationStatus: "VERIFIED",
          deletedAt: null,
          maxOpenRequests: null,
          user: { id: "u-expert", name: "E" },
        },
      })),
    },
    consulteeProfile: {
      findUnique: jest.fn(async () => ({
        user: { id: "u-buyer", name: "B", image: null },
      })),
    },
    // The standing read under a share lock is the only tx call this suite meets.
    $transaction: jest.fn(async (fn: (t: unknown) => unknown) =>
      fn({ $queryRaw: jest.fn(async () => []) }),
    ),
  },
}));

import { NextRequest } from "next/server";
import { POST } from "../../app/api/trials/route";

const DAY_MS = 86_400_000;
const start = new Date(
  Math.ceil((Date.now() + 3 * DAY_MS) / 3_600_000) * 3_600_000,
);
const slot = (minutes = 30) => ({
  startsAt: start.toISOString(),
  endsAt: new Date(start.getTime() + minutes * 60_000).toISOString(),
});
const post = (body: Record<string, unknown> = {}) =>
  POST(
    new NextRequest("http://localhost/api/trials", {
      method: "POST",
      body: JSON.stringify({
        consulteeProfileId: "cp-b",
        consultantProfileId: "cp-e",
        subscriptionPlanId: "plan-1",
        slot: slot(),
        ...body,
      }),
    }),
  );

beforeEach(() => {
  jest.clearAllMocks();
  plan.acceptingRequests = true;
});

it("a paused expert takes no paid trial request: 409 NOT_ACCEPTING_BOOKINGS, nothing written", async () => {
  plan.acceptingRequests = false;
  plan.trialPriceInPaise = 50_000;
  const res = await post();
  expect(res.status).toBe(409);
  expect((await res.json()).code).toBe("NOT_ACCEPTING_BOOKINGS");
  expect(bookTrial).not.toHaveBeenCalled();
  expect(createIntent).not.toHaveBeenCalled();
});

it("a request with no picked time is refused before anything is read or locked", async () => {
  const res = await post({ slot: undefined });
  expect(res.status).toBe(400);
  expect(lockPick).not.toHaveBeenCalled();
});

it("a window that is not the trial's length answers 400 WINDOW_DURATION_MISMATCH", async () => {
  plan.trialPriceInPaise = 0;
  const res = await post({ slot: slot(60) });
  expect(res.status).toBe(400);
  expect((await res.json()).code).toBe("WINDOW_DURATION_MISMATCH");
  expect(bookTrial).not.toHaveBeenCalled();
});

it("a learner past today's trial limit is told so, and when to try again: 429, nothing minted", async () => {
  plan.trialPriceInPaise = 50_000;
  const retryAt = new Date(Date.now() + 90 * 60_000);
  bookTrial.mockRejectedValueOnce(new MockTrialDailyLimitError(retryAt));
  const res = await post();
  expect(res.status).toBe(429);
  expect(await res.json()).toMatchObject({
    error: "You've reached today's trial request limit.",
    code: "RATE_LIMITED",
    retryAt: retryAt.toISOString(),
  });
  expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(5390);
  expect(Number(res.headers.get("Retry-After"))).toBeLessThanOrEqual(5400);
  expect(createIntent).not.toHaveBeenCalled();
  expect(release).toHaveBeenCalledTimes(1);
});

it("the daily limit has one mechanism: the request limiter pair is gone", () => {
  const read = (rel: string) =>
    jest
      .requireActual<typeof import("fs")>("fs")
      .readFileSync(`${process.cwd()}/${rel}`, "utf8");
  expect(read("app/api/trials/route.ts")).not.toContain("lib/rate-limit");
  expect(read("lib/rate-limit.ts")).not.toContain("rl:trial-request");
});

it("a paid pick inside the unpaid lead time answers 409 REQUEST_TOO_SOON", async () => {
  plan.trialPriceInPaise = 50_000;
  const soon = new Date(Date.now() + 60 * 60_000);
  const res = await post({
    slot: {
      startsAt: soon.toISOString(),
      endsAt: new Date(soon.getTime() + 30 * 60_000).toISOString(),
    },
  });
  expect(res.status).toBe(409);
  expect((await res.json()).code).toBe("REQUEST_TOO_SOON");
  expect(lockPick).not.toHaveBeenCalled();
});

it("a paid trial holds the picked time and mints the order against its appointment", async () => {
  plan.trialPriceInPaise = 50_000;
  const res = await post();
  expect(res.status).toBe(201);
  expect(bookTrial).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({
      paid: true,
      startsAt: start,
      endsAt: new Date(start.getTime() + 30 * 60_000),
    }),
  );
  expect(createIntent).toHaveBeenCalledWith(
    expect.objectContaining({ trialId: "trial-1", appointmentId: "apt-1" }),
  );
  expect(prepareNotices).not.toHaveBeenCalled();
  expect(stageNotices).not.toHaveBeenCalled();
  expect((await res.json()).checkoutUrl).toBe("/checkout/plans/trial/trial-1");
  expect(release).toHaveBeenCalledTimes(1);
});

it("a free trial is confirmed with the request: notices staged, nothing minted", async () => {
  plan.trialPriceInPaise = 0;
  const res = await post();
  expect(res.status).toBe(201);
  expect(bookTrial).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ paid: false }),
  );
  expect(prepareNotices).toHaveBeenCalledWith(
    expect.objectContaining({ startsAt: start }),
  );
  expect(stageNotices).toHaveBeenCalledWith(
    expect.anything(),
    "trial-1",
    prepared,
  );
  expect(createIntent).not.toHaveBeenCalled();
  expect((await res.json()).data.status).toBe("SCHEDULED");
});

// Nothing accepts or declines a trial: its PATCH takes only COMPLETED, CONVERTED and CANCELLED.
it("the trial PATCH has no accept or decline door", () => {
  const route = jest
    .requireActual<typeof import("fs")>("fs")
    .readFileSync(`${process.cwd()}/app/api/trials/[trialId]/route.ts`, "utf8");
  expect(route).not.toContain("TRIAL_UNPAID");
  expect(route).not.toContain("REJECTED");
  expect(route).not.toContain("createApprovalPaymentIntent");
});
