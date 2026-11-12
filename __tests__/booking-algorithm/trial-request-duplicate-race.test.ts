/**
 * @jest-environment node
 */

/**
 * Defect 7 — a duplicate trial request answers 409, not 500.
 *
 * POST /api/trials reads the pair, deletes a freed row, then inserts. Those
 * are three statements, so two concurrent requests for the same
 * consultee/consultant pair can both clear the eligibility read and both
 * reach the insert. The loser trips `@@unique([consulteeProfileId,
 * consultantProfileId])` and used to fall into the route's generic catch as a
 * 500 — an alarming answer to a question the sequential path already answers
 * calmly. Here we pin that the race and the sequential case give the client
 * the same 409 + `TRIAL_ALREADY_REQUESTED` code, and that a genuine failure
 * still escalates.
 */

import { Prisma, TrialStatus } from "@prisma/client";

jest.mock("../../lib/auth-server", () => ({
  __esModule: true,
  getSession: jest.fn(),
}));

jest.mock("../../lib/rate-limit", () => ({
  __esModule: true,
  trialRequestRefusal: jest.fn(async () => null),
  spendTrialRequest: jest.fn(async () => undefined),
}));

jest.mock("../../lib/trials/book-trial", () => ({
  lockTrialPick: jest.fn(async () => async () => undefined),
  // The booking's own insert stands in for the whole in-transaction write.
  bookTrialInTx: jest.fn(
    async (
      tx: { trial: { create: (a: unknown) => Promise<object> } },
      args: Record<string, unknown>,
    ) => ({
      ...(await tx.trial.create({ data: args })),
      appointmentId: "apt-1",
    }),
  ),
  TrialTimeRefusedError: class extends Error {},
}));
jest.mock("../../lib/trials/schedule-notices", () => ({
  stageTrialScheduledNotices: jest.fn(async () => ({
    consulteeBell: null,
    consultantBell: null,
    emails: [],
  })),
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
jest.mock("../../lib/novu/stage-then-attempt", () => ({
  flushNotificationsAfter: jest.fn(async () => undefined),
}));

jest.mock("../../utils/appointmentlock", () => ({
  lockRequestCap: jest.fn(async () => ({ key: "request-cap" })),
  unlockRequestCap: jest.fn(async () => undefined),
  RequestCapBusyError: class extends Error {},
  BookingLockUnavailableError: class extends Error {},
}));

jest.mock("../../lib/prisma", () => {
  const db: Record<string, unknown> = {
    trial: {
      findUnique: jest.fn(),
      deleteMany: jest.fn(),
      create: jest.fn(),
    },
    subscriptionPlan: { findUnique: jest.fn() },
    consultantProfile: { findUnique: jest.fn(async () => null) },
    consulteeProfile: { findUnique: jest.fn() },
    membership: { findFirst: jest.fn() },
  };
  // The create runs in the booking transaction.
  db.$transaction = jest.fn(async (fn: (tx: unknown) => unknown) => fn(db));
  return { __esModule: true, default: db };
});

import prisma from "../../lib/prisma";
import { getSession } from "../../lib/auth-server";
import { POST } from "../../app/api/trials/route";

const CONSULTEE = "consultee-1";
const CONSULTANT = "consultant-1";
const PLAN = "plan-1";

const pickStart = new Date(
  Math.ceil((Date.now() + 3 * 86_400_000) / 3_600_000) * 3_600_000,
);
const pickedSlot = {
  startsAt: pickStart.toISOString(),
  endsAt: new Date(pickStart.getTime() + 30 * 60_000).toISOString(),
};

const mockedSession = getSession as jest.Mock;
const mockedFindUnique = prisma.trial.findUnique as jest.Mock;
const mockedCreate = prisma.trial.create as jest.Mock;
const mockedDeleteMany = prisma.trial.deleteMany as jest.Mock;

function uniqueViolation() {
  return new Prisma.PrismaClientKnownRequestError(
    "Unique constraint failed on the fields: (`consulteeProfileId`,`consultantProfileId`)",
    {
      code: "P2002",
      clientVersion: "6.0.0",
      meta: {
        target: ["consulteeProfileId", "consultantProfileId"],
      },
    },
  );
}

function request() {
  return new Request("http://localhost/api/trials", {
    method: "POST",
    body: JSON.stringify({
      consulteeProfileId: CONSULTEE,
      consultantProfileId: CONSULTANT,
      subscriptionPlanId: PLAN,
      slot: pickedSlot,
    }),
  }) as never;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedSession.mockResolvedValue({
    user: {
      id: "user-1",
      role: "CONSULTEE",
      consulteeProfileId: CONSULTEE,
    },
  });
  // No prior trial for the pair — the read-side gate passes.
  mockedFindUnique.mockResolvedValue(null);
  mockedDeleteMany.mockResolvedValue({ count: 1 });
  (prisma.subscriptionPlan.findUnique as jest.Mock).mockResolvedValue({
    id: PLAN,
    title: "Career Clarity",
    consultantProfileId: CONSULTANT,
    trialEnabled: true,
    trialDurationMinutes: 30,
    trialPriceInPaise: 0,
    consultantProfile: {
      maxOpenRequests: null,
      user: { id: "expert-1", name: "Expert" },
    },
  });
  (prisma.consulteeProfile.findUnique as jest.Mock).mockResolvedValue({
    id: CONSULTEE,
    user: { id: "user-1", name: "Learner", email: "l@x.com", image: null },
  });
  mockedCreate.mockResolvedValue({
    id: "trial-1",
    status: TrialStatus.PENDING,
    consulteeProfile: { user: { id: "user-1", name: "Learner" } },
    consultantProfile: { user: { id: "expert-1", name: "Expert" } },
  });
});

describe("duplicate trial requests (defect 7)", () => {
  it("answers 409 TRIAL_ALREADY_REQUESTED when the insert loses the race", async () => {
    mockedCreate.mockRejectedValue(uniqueViolation());

    const res = await POST(request());

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "You have already requested a trial with this consultant",
      code: "TRIAL_ALREADY_REQUESTED",
    });
  });

  it("answers the same 409 on the sequential path, so the client branches once", async () => {
    // A live trial already exists — no race, the read-side gate catches it.
    mockedFindUnique.mockResolvedValue({
      id: "trial-existing",
      status: TrialStatus.PENDING,
    });

    const res = await POST(request());

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("TRIAL_ALREADY_REQUESTED");
    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it("still 500s on a failure that is not a unique violation", async () => {
    mockedCreate.mockRejectedValue(new Error("connection reset"));

    const res = await POST(request());

    expect(res.status).toBe(500);
    expect((await res.json()).code).toBeUndefined();
  });

  it("answers 409, not 500, when the rival clears the freed row first", async () => {
    // A declined trial frees the pair, so both requests read it and both go to
    // clear it. `delete` would raise P2025 on the loser and fall into the
    // generic catch as a 500 — one statement earlier than the unique violation
    // this route already answers calmly. `deleteMany` reports a count of zero
    // instead, and the insert stays the arbiter.
    mockedFindUnique.mockResolvedValue({
      id: "trial-freed",
      status: TrialStatus.REJECTED,
    });
    mockedDeleteMany.mockResolvedValue({ count: 0 });
    mockedCreate.mockRejectedValue(uniqueViolation());

    const res = await POST(request());

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("TRIAL_ALREADY_REQUESTED");
  });

  it("creates normally when nothing collides", async () => {
    const res = await POST(request());

    expect(res.status).toBe(201);
    expect(mockedCreate).toHaveBeenCalledTimes(1);
  });
});
