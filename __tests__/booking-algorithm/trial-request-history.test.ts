/**
 * @jest-environment node
 */

/**
 * A request after an ended trial adds a row; a held pair, or a lost race to its index, answers 409.
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
  TrialPairHeldError: class extends Error {},
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

type TrialRow = {
  id: string;
  status: TrialStatus;
  consulteeProfileId: string;
  consultantProfileId: string;
  appointmentId: string | null;
  requestedAt: Date;
};

// The pair's stored trials; findFirst applies the route's own where and select.
const stored: TrialRow[] = [];

jest.mock("../../lib/prisma", () => {
  const db: Record<string, unknown> = {
    trial: {
      findFirst: jest.fn(
        async (args: {
          where: {
            consulteeProfileId: string;
            consultantProfileId: string;
            status: { in: TrialStatus[] };
          };
          select: { id: true };
        }) => {
          const hit = stored.find(
            (row) =>
              row.consulteeProfileId === args.where.consulteeProfileId &&
              row.consultantProfileId === args.where.consultantProfileId &&
              args.where.status.in.includes(row.status),
          );
          return hit ? { id: hit.id } : null;
        },
      ),
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
import { bookTrialInTx, TrialPairHeldError } from "../../lib/trials/book-trial";
import { TRIAL_REQUEST_BLOCKING_STATUSES } from "../../lib/trials/eligibility";

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
const mockedCreate = prisma.trial.create as jest.Mock;

/** P2002 as Prisma 7 with adapter-pg raises it: the index name rides the adapter cause. */
function uniqueViolation(index: string) {
  return new Prisma.PrismaClientKnownRequestError(
    `Unique constraint failed on the constraint: \`${index}\``,
    {
      code: "P2002",
      clientVersion: "7.0.0",
      meta: {
        modelName: "Trial",
        driverAdapterError: {
          cause: {
            originalCode: "23505",
            originalMessage: `duplicate key value violates unique constraint "${index}"`,
            kind: "UniqueConstraintViolation",
            constraint: { index },
          },
        },
      },
    },
  );
}

function storedTrial(status: TrialStatus): TrialRow {
  return {
    id: `trial-${status.toLowerCase()}`,
    status,
    consulteeProfileId: CONSULTEE,
    consultantProfileId: CONSULTANT,
    appointmentId: `apt-${status.toLowerCase()}`,
    requestedAt: new Date("2026-11-01T10:00:00.000Z"),
  };
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
  stored.length = 0;
  mockedSession.mockResolvedValue({
    user: {
      id: "user-1",
      role: "CONSULTEE",
      consulteeProfileId: CONSULTEE,
    },
  });
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
    status: TrialStatus.SCHEDULED,
    consulteeProfile: { user: { id: "user-1", name: "Learner" } },
    consultantProfile: { user: { id: "expert-1", name: "Expert" } },
  });
});

describe("POST /api/trials keeps the pair's history", () => {
  it("creates a new trial after a cancelled one and never writes the earlier row", async () => {
    const earlier = storedTrial(TrialStatus.CANCELLED);
    stored.push(earlier);
    const snapshot = { ...earlier };

    const res = await POST(request());

    expect(res.status).toBe(201);
    expect(mockedCreate).toHaveBeenCalledTimes(1);
    expect(stored).toEqual([snapshot]);
    // The trial delegate offers only the read and the insert.
    expect(Object.keys(prisma.trial).sort()).toEqual(["create", "findFirst"]);
  });

  it.each(TRIAL_REQUEST_BLOCKING_STATUSES)(
    "refuses with 409 while an earlier %s trial holds the pair",
    async (status) => {
      stored.push(storedTrial(TrialStatus.CANCELLED), storedTrial(status));

      const res = await POST(request());

      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        error: "You have already requested a trial with this consultant",
        code: "TRIAL_ALREADY_REQUESTED",
      });
      expect(mockedCreate).not.toHaveBeenCalled();
    },
  );

  it("answers the same 409 when the insert loses the race to the pair index", async () => {
    mockedCreate.mockRejectedValue(
      uniqueViolation("trial_one_blocking_per_pair_key"),
    );

    const res = await POST(request());

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("TRIAL_ALREADY_REQUESTED");
  });

  it("answers the same 409 when the in-transaction recheck finds the pair held", async () => {
    (bookTrialInTx as jest.Mock).mockRejectedValueOnce(
      new TrialPairHeldError(),
    );

    const res = await POST(request());

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("TRIAL_ALREADY_REQUESTED");
  });

  it("500s on a unique violation of any other constraint", async () => {
    mockedCreate.mockRejectedValue(uniqueViolation("Trial_appointmentId_key"));

    const res = await POST(request());

    expect(res.status).toBe(500);
    expect((await res.json()).code).toBeUndefined();
  });

  it("still 500s on a failure that is not a unique violation", async () => {
    mockedCreate.mockRejectedValue(new Error("connection reset"));

    const res = await POST(request());

    expect(res.status).toBe(500);
    expect((await res.json()).code).toBeUndefined();
  });
});
