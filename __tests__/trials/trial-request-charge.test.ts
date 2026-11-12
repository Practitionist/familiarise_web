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
const trialRequestRefusal = jest.fn(async () => null);
const spendTrialRequest = jest.fn(async () => undefined);
jest.mock("../../lib/rate-limit", () => ({
  trialRequestRefusal: (...a: unknown[]) => trialRequestRefusal(...(a as [])),
  spendTrialRequest: (...a: unknown[]) => spendTrialRequest(...(a as [])),
}));
jest.mock("../../lib/email/senders/booking", () => ({
  prepareTrialScheduledEmail: jest.fn(async () => ({
    emailType: "TRIAL_SESSION_SCHEDULED",
    entityRef: "trial:pending",
    messages: [],
    skipped: 0,
    failed: 0,
  })),
}));
const stageNotices = jest.fn(async () => ({
  consulteeBell: null,
  consultantBell: null,
  emails: [],
}));
jest.mock("../../lib/trials/schedule-notices", () => ({
  stageTrialScheduledNotices: (...a: unknown[]) => stageNotices(...(a as [])),
}));
jest.mock("../../lib/novu/stage-then-attempt", () => ({
  flushNotificationsAfter: jest.fn(async () => undefined),
}));
jest.mock("../../utils/appointmentlock", () => ({
  lockRequestCap: jest.fn(async () => ({ key: "request-cap" })),
  unlockRequestCap: jest.fn(async () => undefined),
  RequestCapBusyError: class extends Error {},
  BookingLockUnavailableError: class extends Error {},
}));
const release = jest.fn(async () => undefined);
const lockPick = jest.fn(async () => release);
const bookTrial = jest.fn(async (_tx: unknown, args: { paid: boolean }) => ({
  id: "trial-1",
  status: args.paid ? "AWAITING_PAYMENT" : "SCHEDULED",
  appointmentId: "apt-1",
  consulteeProfile: { user: { name: "B" } },
  consultantProfile: { user: { id: "u-expert", name: "E" } },
}));
jest.mock("../../lib/trials/book-trial", () => ({
  lockTrialPick: (...a: unknown[]) => lockPick(...(a as [])),
  bookTrialInTx: (...a: unknown[]) =>
    bookTrial(...(a as [unknown, { paid: boolean }])),
  TrialTimeRefusedError: class extends Error {},
}));

const plan = { trialPriceInPaise: 0, acceptingRequests: true };
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    trial: { findUnique: jest.fn(async () => null) },
    consultantProfile: { findUnique: jest.fn(async () => null) },
    subscriptionPlan: {
      findUnique: jest.fn(async () => ({
        id: "plan-1",
        title: "Mentorship",
        consultantProfileId: "cp-e",
        trialEnabled: true,
        trialDurationMinutes: 30,
        trialPriceInPaise: plan.trialPriceInPaise,
        consultantProfile: {
          acceptingRequests: plan.acceptingRequests,
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
    $transaction: jest.fn(async (fn: (t: unknown) => unknown) => fn({})),
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

it("a refused request costs no attempt; only a created trial spends one", async () => {
  plan.trialPriceInPaise = 0;
  const refused = await post({ slot: slot(60) });
  expect(refused.status).toBe(400);
  expect(trialRequestRefusal).not.toHaveBeenCalled();
  expect(spendTrialRequest).not.toHaveBeenCalled();
  const created = await post();
  expect(created.status).toBe(201);
  expect(spendTrialRequest).toHaveBeenCalledTimes(1);
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
  expect(stageNotices).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ trialId: "trial-1", startsAt: start }),
  );
  expect(createIntent).not.toHaveBeenCalled();
  expect((await res.json()).data.status).toBe("SCHEDULED");
});

// #1775 C-10 — accept requires the capture; a paid trial's session goes on
// the request-time placeholder and nothing is minted on accept.
describe("trial accept", () => {
  const route = jest
    .requireActual<typeof import("fs")>("fs")
    .readFileSync(`${process.cwd()}/app/api/trials/[trialId]/route.ts`, "utf8");

  it("refuses an unpaid paid trial with TRIAL_UNPAID", () => {
    const guard = route.split('"TRIAL_UNPAID"')[0].slice(-400);
    expect(guard).toContain("paidTrial &&");
    expect(route).toContain("existingTrial.appointmentId !== null;");
    expect(guard).toContain("existingTrial.paymentId === null");
  });

  it("places the session on the existing appointment and never mints", () => {
    const accept = route.split("async function acceptPaidTrial(")[1];
    expect(accept).toContain("tx.appointmentOccurrence.create({");
    expect(accept).toContain("data: { appointmentId, ...session }");
    expect(route).toContain("whereAnd: { paymentId: { not: null } }");
    expect(route).not.toContain("createApprovalPaymentIntent");
  });
});
