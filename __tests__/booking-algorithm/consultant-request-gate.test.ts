/**
 * @jest-environment node
 */

/**
 * #1703 D4 — the consultant-side gate on POST /api/scheduling/request-for-approval:
 * a paused profile answers 409 CONSULTANT_PAUSED before any lock; a profile at
 * its open-request cap answers 409 CONSULTANT_AT_CAPACITY from a count taken
 * inside the slot lock; below the cap the request is created (201).
 *
 * Collaborators are boundary-mocked: auth, the limiter, the locks, the
 * validator, the notifiers. What is under test is the gate and its codes.
 */

import { requestDoorProfile } from "../fixtures/request-door-db";

// The database's host-time locks are pinned in host-time-locks.test.ts.
jest.mock("../../lib/booking/allocation/host-time-locks", () => ({
  lockHostTimeInTx: jest.fn(async () => undefined),
}));
jest.mock("../../lib/auth-server", () => ({
  getSession: jest.fn(async () => ({ user: { id: "user_consultee" } })),
}));
jest.mock("../../lib/rate-limit", () => ({
  __esModule: true,
  applyRateLimit: jest.fn(async () => null),
  requestApprovalLimiter: {},
}));
jest.mock("../../lib/profiles/ensure-consultee-profile", () => ({
  ensureConsulteeProfile: jest.fn(async () => undefined),
}));
const mockLockSlotBooking = jest.fn(async (..._args: unknown[]) => ({
  key: "slot",
}));
const mockLockRequestCap = jest.fn(async (..._args: unknown[]) => ({
  key: "request-cap",
}));
const mockLockConsulteeBooking = jest.fn(async (..._args: unknown[]) => ({
  key: "consultee",
}));
const MOCK_LOCK_BUDGET = { deadlineAt: 1 };
jest.mock("../../utils/appointmentlock", () => ({
  lockSlotBatch: (...a: unknown[]) => mockLockSlotBooking(...(a as [])),
  unlockSlotInterval: jest.fn(async () => undefined),
  lockConsulteeBooking: (...a: unknown[]) =>
    mockLockConsulteeBooking(...(a as [])),
  unlockConsulteeBooking: jest.fn(async () => undefined),
  renewConsulteeBooking: jest.fn(async () => undefined),
  lockRequestCap: (...a: unknown[]) => mockLockRequestCap(...(a as [])),
  unlockRequestCap: jest.fn(async () => undefined),
  requestLockBudget: () => MOCK_LOCK_BUDGET,
  BookingLockUnavailableError: class extends Error {},
  ConsulteeBookingBusyError: class ConsulteeBookingBusyError extends Error {},
  LockContentionError: class extends Error {},
  RequestCapBusyError: class extends Error {},
}));
const mockCheckSlotAvailability = jest.fn(async () => ({
  isValid: true,
  errors: [] as string[],
  warnings: [] as string[],
  conflicts: [] as { otherParty: { userId: string } | null }[],
}));
jest.mock("../../utils/scheduling-engine/ScheduleValidationService", () => ({
  ScheduleValidationService: class {
    checkSlotAvailability = (...a: unknown[]) =>
      mockCheckSlotAvailability(...(a as []));
  },
}));
jest.mock("../../lib/booking/allocation/coverage", () =>
  jest.requireActual("../fixtures/request-door-hours"),
);
jest.mock("../../lib/novu", () => ({}));
// The expert's notices: prepared before the transaction, staged inside it.
const PREPARED_NOTICES = { bells: [], emails: { prepared: {}, screened: [] } };
const STAGED_NOTICES = {
  bells: [{ id: "bell_1" }],
  emails: [{ staged: { id: "mail_1" } }],
};
const mockPrepareNotices = jest.fn(
  async (..._args: unknown[]) => PREPARED_NOTICES,
);
const mockStageNotices = jest.fn(async (..._args: unknown[]) => STAGED_NOTICES);
jest.mock("../../lib/booking/request-notices", () => ({
  prepareNewRequestNotices: (...a: unknown[]) => mockPrepareNotices(...a),
  stageNewRequestNotices: (...a: unknown[]) => mockStageNotices(...a),
}));
const mockFlush = jest.fn(async (..._args: unknown[]) => undefined);
jest.mock("../../lib/novu/stage-then-attempt", () => ({
  flushNotificationsAfter: (...a: unknown[]) => mockFlush(...a),
}));
jest.mock("../../lib/novu/workflows", () => ({
  ...jest.requireActual("../../lib/novu/workflows"),
  notificationScope: () => ({ organizationId: null, scope: "personal" }),
}));
// The route imports the stale-request sweep for its window constant, and the
// sweep's nudge pass (#1703) pulls the Novu service and outbox.
jest.mock("../../lib/novu/service", () => ({}));
jest.mock("../../lib/novu/outbox", () => ({ deriveTransactionId: jest.fn() }));
jest.mock("../../lib/novu/resolve-href", () => ({ scopedHref: () => "/x" }));
jest.mock("../../lib/email", () => ({
  EMAIL_BUDGET_MS: { REQUEST: 1 },
  sendNewBookingRequestEmail: jest.fn(async () => ({ success: true })),
}));
jest.mock("../../lib/booking/transitions", () => ({
  appendCreationHistory: jest.fn(async () => undefined),
}));
jest.mock("../../lib/booking/participants", () => ({
  recordParticipants: jest.fn(async () => undefined),
}));
// The expiry sweep the route's module imports ends Stream access; no case here reaches it.
jest.mock("../../lib/stream/access-revocation", () => ({
  revokeEndedSeatAccess: jest.fn(),
}));
jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));

const mockConsultationCount = jest.fn(async () => 0);
const mockSubscriptionCount = jest.fn(async () => 0);
const mockTrialCount = jest.fn(async () => 0);
const mockProfile = requestDoorProfile();
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: jest
    .requireActual("../fixtures/request-door-db")
    .requestDoorDb(() => mockProfile, {
      consultation: (...a: unknown[]) => mockConsultationCount(...(a as [])),
      subscription: (...a: unknown[]) => mockSubscriptionCount(...(a as [])),
      trial: (...a: unknown[]) => mockTrialCount(...(a as [])),
    }),
}));

import { NextRequest } from "next/server";
import prisma from "../../lib/prisma";
import { POST } from "../../app/api/scheduling/request-for-approval/route";
import { PROFILE_WITH_USER_SELECT } from "../../lib/booking/list-selects";
import { AllocationConflictError } from "../../utils/scheduling-engine/errors";
import { freezeDateAt } from "../fixtures/frozen-date";
import { assertSlotsStillPublished } from "../../lib/booking/allocation/coverage";
import {
  expectNoBareProfile,
  valuesAtKey,
} from "../fixtures/consultant-projection";

const mockedPrisma = prisma as unknown as {
  consultation: { create: jest.Mock; findUnique: jest.Mock };
};

function request(
  startsAt = "2030-01-01T10:00:00.000Z",
  headers: Record<string, string> = {},
) {
  return new NextRequest("https://x.test/api/scheduling/request-for-approval", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({
      consultantProfileId: "cp_1",
      consultationPlanId: "plan_1",
      startsAt,
      endsAt: "2030-01-01T11:00:00.000Z",
      availabilityWindowWeeklyId: "aw_1",
    }),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  // The 2030 fixtures sit a few weeks ahead, inside the booking horizon.
  freezeDateAt("2029-12-10T00:00:00.000Z");
  jest.spyOn(console, "log").mockImplementation(() => {});
  mockProfile.acceptingRequests = true;
  mockProfile.bookingMode = "REQUEST";
  mockProfile.maxOpenRequests = null;
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe("consultant request gate", () => {
  it("paused → 409 CONSULTANT_PAUSED before any lock", async () => {
    mockProfile.acceptingRequests = false;
    const res = await POST(request());
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("CONSULTANT_PAUSED");
    expect(mockLockSlotBooking).not.toHaveBeenCalled();
  });

  it("an instant-booking expert takes no request → 409 REQUEST_NOT_OFFERED", async () => {
    mockProfile.bookingMode = "INSTANT";
    const res = await POST(request());
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      code: "REQUEST_NOT_OFFERED",
      error:
        "This expert takes instant bookings. Pick a free time and continue to checkout.",
    });
    expect(mockLockSlotBooking).not.toHaveBeenCalled();
  });

  it("a switch to instant booking while the request waits for its lock → 409, nothing written", async () => {
    mockLockRequestCap.mockImplementationOnce(async () => {
      mockProfile.bookingMode = "INSTANT";
      return { key: "request-cap" };
    });
    const res = await POST(request());
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("REQUEST_NOT_OFFERED");
    expect(mockedPrisma.consultation.create).not.toHaveBeenCalled();
  });

  it("a pause committed while the request waits for its lock → 409 CONSULTANT_PAUSED, nothing written", async () => {
    mockLockRequestCap.mockImplementationOnce(async () => {
      mockProfile.acceptingRequests = false;
      return { key: "request-cap" };
    });
    const res = await POST(request());
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("CONSULTANT_PAUSED");
    expect(mockedPrisma.consultation.create).not.toHaveBeenCalled();
  });

  it("a cap lowered while the request waits is the cap that decides", async () => {
    mockLockRequestCap.mockImplementationOnce(async () => {
      mockProfile.maxOpenRequests = 1;
      return { key: "request-cap" };
    });
    // The per-consultee count answers first (0), then the consultant count.
    mockConsultationCount.mockResolvedValueOnce(0).mockResolvedValueOnce(1);
    const res = await POST(request());
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("CONSULTANT_AT_CAPACITY");
    expect(mockedPrisma.consultation.create).not.toHaveBeenCalled();
  });

  it("at cap → 409 CONSULTANT_AT_CAPACITY, counted inside the slot lock", async () => {
    mockProfile.maxOpenRequests = 3;
    // The per-consultee count answers first (0), then the consultant count.
    mockConsultationCount.mockResolvedValueOnce(0).mockResolvedValueOnce(2);
    mockSubscriptionCount.mockResolvedValueOnce(1);
    const res = await POST(request());
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("CONSULTANT_AT_CAPACITY");
    expect(mockLockSlotBooking).toHaveBeenCalledTimes(1);
    // The consultant count runs under the expert's request-cap lock and after
    // the slot batch, inside the insert's own transaction.
    expect(mockLockRequestCap.mock.calls[0][0]).toBe("cp_1");
    expect(mockConsultationCount.mock.invocationCallOrder[1]).toBeGreaterThan(
      mockLockSlotBooking.mock.invocationCallOrder[0],
    );
  });

  it("counts real submitted requests, never checkout holds or trials", async () => {
    mockProfile.maxOpenRequests = 3;
    mockConsultationCount.mockResolvedValueOnce(0).mockResolvedValueOnce(1);
    mockSubscriptionCount.mockResolvedValueOnce(2);
    const res = await POST(request());
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("CONSULTANT_AT_CAPACITY");
    const calls = mockConsultationCount.mock.calls as unknown as Array<
      [{ where: Record<string, unknown> }]
    >;
    const consultantCount = calls[1][0];
    expect(consultantCount.where).toMatchObject({
      status: "PENDING",
      bookingSource: "REQUEST_SUBMITTED",
    });
    expect(mockTrialCount).not.toHaveBeenCalled();
  });

  it("answers the consultee's own cap with a typed code and plain copy", async () => {
    mockConsultationCount.mockResolvedValueOnce(3);
    const res = await POST(request());
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.code).toBe("REQUEST_CAP_REACHED");
    expect(body.error).not.toMatch(/limit \d/);
  });

  it("a time outside the published hours → 400 OUTSIDE_AVAILABILITY, nothing written", async () => {
    jest
      .mocked(assertSlotsStillPublished)
      .mockRejectedValueOnce(
        new AllocationConflictError("shrunk", "AVAILABILITY_CHANGED"),
      );
    const res = await POST(request());
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("OUTSIDE_AVAILABILITY");
    expect(mockedPrisma.consultation.create).not.toHaveBeenCalled();
  });

  it("below cap → 201", async () => {
    mockProfile.maxOpenRequests = 3;
    mockConsultationCount.mockResolvedValueOnce(0).mockResolvedValueOnce(1);
    mockSubscriptionCount.mockResolvedValueOnce(1);
    const res = await POST(request());
    expect(res.status).toBe(201);
  });
});

// #1583 B-P1-06 / E-P1-03 — the Zod edge refuses off-grid and too-soon
// starts with a typed code, and the in-lock check sees the consultee too.
describe("request-for-approval learner time", () => {
  it("takes the requester's own time with the expert's, in the write transaction", async () => {
    const { lockHostTimeInTx } = jest.requireMock(
      "../../lib/booking/allocation/host-time-locks",
    ) as { lockHostTimeInTx: jest.Mock };
    const res = await POST(request());
    expect(res.status).toBe(201);
    expect(lockHostTimeInTx.mock.calls[0][3]).toEqual([
      {
        userId: "user_consultee",
        startsAt: "2030-01-01T10:00:00.000Z",
        endsAt: "2030-01-01T11:00:00.000Z",
      },
    ]);
  });
});

describe("request-for-approval lock tiers", () => {
  it("passes one deadline to the cap, consultee and slot tiers", async () => {
    await POST(request());
    expect(mockLockRequestCap.mock.calls[0]).toEqual([
      "cp_1",
      undefined,
      MOCK_LOCK_BUDGET,
    ]);
    expect(mockLockConsulteeBooking.mock.calls[0][2]).toBe(MOCK_LOCK_BUDGET);
    expect(mockLockSlotBooking.mock.calls[0][2]).toBe(MOCK_LOCK_BUDGET);
  });

  it("a consultee key held by another booking → 409 with a retry, never a 500", async () => {
    const { ConsulteeBookingBusyError } = jest.requireMock(
      "../../utils/appointmentlock",
    );
    mockLockConsulteeBooking.mockRejectedValueOnce(
      new ConsulteeBookingBusyError(),
    );
    const res = await POST(request());
    expect(res.status).toBe(409);
    expect((await res.json()).retryAfter).toBe(30);
    expect(mockedPrisma.consultation.create).not.toHaveBeenCalled();
  });
});

describe("request-for-approval slot edge (#1583)", () => {
  it("10:07Z → 400 SLOT_NOT_ON_GRID before any lock", async () => {
    const res = await POST(request("2030-01-01T10:07:00.000Z"));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("SLOT_NOT_ON_GRID");
    expect(mockLockSlotBooking).not.toHaveBeenCalled();
  });

  it("two minutes ahead → 400 SLOT_TOO_SOON", async () => {
    // A frozen clock: 09:58Z against a 10:00Z grid start is two minutes
    // ahead — inside the 15-minute lead — and never in the past.
    jest.useFakeTimers({ now: new Date("2030-01-01T09:58:00.000Z") });
    try {
      const res = await POST(request("2030-01-01T10:00:00.000Z"));
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe("SLOT_TOO_SOON");
    } finally {
      jest.useRealTimers();
    }
  });

  it("passes the consultee to the conflict check and types their own overlap as 409 SLOT_TAKEN", async () => {
    mockCheckSlotAvailability.mockResolvedValueOnce({
      isValid: false,
      errors: ["[CONFLICT] Slot already booked"],
      warnings: [],
      conflicts: [{ otherParty: { userId: "user_consultee" } }],
    });
    const res = await POST(request());
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("SLOT_TAKEN");
    expect(body.error).toMatch(/already have a session/);
    expect(body.details).toBeUndefined();
    expect(mockCheckSlotAvailability).toHaveBeenCalledWith(
      expect.any(Array),
      "user_consultant",
      "cp_1",
      "user_consultee",
    );
  });
});

// The created consultation is echoed to the learner, so the consultant is the public projection.
describe("request-for-approval consultant projection", () => {
  it("creates the consultation with PROFILE_WITH_USER_SELECT and no bare profile", async () => {
    const res = await POST(request());
    expect(res.status).toBe(201);
    const args = mockedPrisma.consultation.create.mock.calls[0][0];
    expectNoBareProfile(args);
    expect(valuesAtKey(args, "consultantProfile")).toEqual([
      PROFILE_WITH_USER_SELECT,
    ]);
  });
});

describe("request-for-approval expert notices", () => {
  it("stages the notices in the request's transaction, keyed by the request, and sends them after the commit", async () => {
    const transaction = (mockedPrisma as unknown as { $transaction: jest.Mock })
      .$transaction;
    // A transaction client distinct from the global one, with the same models.
    const tx: unknown = Object.create(mockedPrisma);
    transaction.mockImplementationOnce(
      async (fn: (client: unknown) => unknown) => fn(tx),
    );

    const res = await POST(request());
    expect(res.status).toBe(201);

    // Read and rendered before the transaction opens; staged on its client.
    expect(mockPrepareNotices.mock.invocationCallOrder[0]).toBeLessThan(
      transaction.mock.invocationCallOrder[0],
    );
    expect(mockPrepareNotices.mock.calls[0][0]).toMatchObject({
      consultantUserId: "user_consultant",
      planTitle: "Plan",
      organizationId: null,
    });
    expect(mockStageNotices).toHaveBeenCalledTimes(1);
    // Written on the transaction's client, never the global one.
    const [client, requestId, prepared] = mockStageNotices.mock.calls[0];
    expect(client).toBe(tx);
    expect(client).not.toBe(mockedPrisma);
    expect(requestId).toBe("req_1");
    expect(prepared).toBe(PREPARED_NOTICES);
    expect(mockFlush.mock.calls[0][0]).toMatchObject({
      bells: STAGED_NOTICES.bells,
      emails: [
        { rows: STAGED_NOTICES.emails, emailType: "NEW_BOOKING_REQUEST" },
      ],
    });
  });

  it("a refused request stages and sends nothing", async () => {
    mockProfile.maxOpenRequests = 1;
    mockConsultationCount.mockResolvedValueOnce(0).mockResolvedValueOnce(1);
    const res = await POST(request());
    expect(res.status).toBe(409);
    expect(mockStageNotices).not.toHaveBeenCalled();
    expect(mockFlush).not.toHaveBeenCalled();
  });
});

describe("request-for-approval Idempotency-Key", () => {
  const SLOT = "2030-01-01T10:00:00.000Z";
  const original = () => ({
    id: "req_original",
    consultationPlanId: "plan_1",
    requestedBy: { userId: "user_consultee", user: { name: "Sam" } },
    appointment: {
      occurrences: [
        {
          startsAt: new Date(SLOT),
          endsAt: new Date("2030-01-01T11:00:00.000Z"),
          deletedAt: null,
        },
      ],
    },
  });

  it("a replay with the same key returns the original request and creates nothing", async () => {
    mockedPrisma.consultation.findUnique.mockResolvedValueOnce(original());
    const res = await POST(
      request(SLOT, { "Idempotency-Key": "rq_attempt_1" }),
    );
    expect(res.status).toBe(201);
    expect((await res.json()).data.id).toBe("req_original");
    expect(mockedPrisma.consultation.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { requestIdempotencyKey: "rq_attempt_1" },
      }),
    );
    expect(mockedPrisma.consultation.create).not.toHaveBeenCalled();
    expect(mockLockSlotBooking).not.toHaveBeenCalled();
    // The first submit staged the expert's notices; a replay sends nothing again.
    expect(mockStageNotices).not.toHaveBeenCalled();
    expect(mockFlush).not.toHaveBeenCalled();
  });

  it("the same key with another time is refused, not replayed", async () => {
    mockedPrisma.consultation.findUnique.mockResolvedValueOnce(original());
    const res = await POST(
      request("2030-01-01T10:30:00.000Z", {
        "Idempotency-Key": "rq_attempt_1",
      }),
    );
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(mockedPrisma.consultation.create).not.toHaveBeenCalled();
  });

  it("the same key with another sponsoring organisation is refused, not replayed", async () => {
    mockedPrisma.consultation.findUnique.mockResolvedValueOnce(original());
    const res = await POST(
      new NextRequest("https://x.test/api/scheduling/request-for-approval", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "rq_attempt_1",
        },
        body: JSON.stringify({
          consultantProfileId: "cp_1",
          consultationPlanId: "plan_1",
          startsAt: SLOT,
          endsAt: "2030-01-01T11:00:00.000Z",
          availabilityWindowWeeklyId: "aw_1",
          organizationId: "org_1",
        }),
      }),
    );
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  it("a different key creates a new request that carries its key", async () => {
    const res = await POST(
      request(SLOT, { "Idempotency-Key": "rq_attempt_2" }),
    );
    expect(res.status).toBe(201);
    expect(
      mockedPrisma.consultation.create.mock.calls[0][0].data
        .requestIdempotencyKey,
    ).toBe("rq_attempt_2");
  });

  describe("with the submitted request stored", () => {
    /** The fingerprint the route stores for `request(SLOT)`. */
    async function storedFingerprint(): Promise<string> {
      await POST(request(SLOT, { "Idempotency-Key": "rq_stored_1" }));
      const stored =
        mockedPrisma.consultation.create.mock.calls[0][0].data
          .requestFingerprint;
      expect(stored).toMatch(/^[0-9a-f]{64}$/);
      mockedPrisma.consultation.create.mockClear();
      return stored;
    }
    const replaced = (requestFingerprint: string) => ({
      ...original(),
      requestFingerprint,
      // The expert placed the session at another time since.
      appointment: {
        occurrences: [
          {
            startsAt: new Date("2030-01-03T09:00:00.000Z"),
            endsAt: new Date("2030-01-03T10:00:00.000Z"),
            deletedAt: null,
          },
        ],
      },
    });

    it.each([
      ["before", (fp: string) => ({ ...original(), requestFingerprint: fp })],
      ["after", replaced],
    ])(
      "a same-key retry replays 201 %s the expert re-places the time",
      async (_when, row) => {
        const fp = await storedFingerprint();
        mockedPrisma.consultation.findUnique.mockResolvedValueOnce(row(fp));
        const res = await POST(
          request(SLOT, { "Idempotency-Key": "rq_stored_1" }),
        );
        expect(res.status).toBe(201);
        expect(mockedPrisma.consultation.create).not.toHaveBeenCalled();
      },
    );

    it("the same key with a genuinely different window still answers 422", async () => {
      const fp = await storedFingerprint();
      mockedPrisma.consultation.findUnique.mockResolvedValueOnce(replaced(fp));
      const res = await POST(
        request("2030-01-01T10:30:00.000Z", {
          "Idempotency-Key": "rq_stored_1",
        }),
      );
      expect(res.status).toBe(422);
      expect((await res.json()).code).toBe("IDEMPOTENCY_KEY_REUSED");
    });
  });
});
