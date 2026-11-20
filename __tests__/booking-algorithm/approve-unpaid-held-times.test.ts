/**
 * @jest-environment node
 */

/**
 * An unanswered request stops holding its time by the clock while its row is
 * still PENDING, and an approval makes it hold that time again. So approving
 * an unpaid request confirms the time is still free first, as a paid one does.
 */
import { NextRequest } from "next/server";

const ID = "0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d";
const START = new Date(Date.now() + 3 * 24 * 3_600_000);

const mockRevalidate = jest.fn();
const requestRow = () => ({
  id: ID,
  status: "PENDING",
  pendingPaymentUrl: null,
  requestedById: "cee-1",
  requestedBy: { id: "cee-1", userId: "u-learner", user: { id: "u-learner" } },
  consultationPlan: {
    price: 1_000,
    consultantProfile: { id: "cp-1", user: { id: "u-expert" } },
  },
  appointment: { id: "appt-1", deletedAt: null, payment: [], occurrences: [] },
});
const mockTx = {
  consultation: {
    findUnique: jest.fn(async () => requestRow()),
    findUniqueOrThrow: jest.fn(async () => requestRow()),
    count: jest.fn(async () => 0),
    updateMany: jest.fn(async () => ({ count: 1 })),
  },
  appointment: {
    findFirst: jest.fn(async () => null),
    findUnique: jest.fn(async () => ({
      participants: [
        { userId: "u-expert", role: "CONSULTANT" },
        { userId: "u-learner", role: "CONSULTEE" },
      ],
      occurrences: [
        {
          startsAt: START,
          endsAt: new Date(START.getTime() + 3_600_000),
          consultantProfileId: "cp-1",
        },
      ],
    })),
  },
  appointmentOccurrence: {
    findFirst: jest.fn(async () => ({ startsAt: START })),
  },
  bookingStatusHistory: { create: jest.fn(async () => ({})) },
};

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    consultation: {
      findUnique: jest.fn(async () => requestRow()),
      findUniqueOrThrow: jest.fn(async () => requestRow()),
    },
    $transaction: jest.fn(async (run: (tx: unknown) => unknown) => run(mockTx)),
  },
}));
jest.mock("../../utils/scheduling-engine/ScheduleValidationService", () => ({
  ScheduleValidationService: jest.fn().mockImplementation(() => ({
    revalidateConflicts: mockRevalidate,
  })),
}));
jest.mock("../../utils/appointmentlock", () => ({
  ...jest.requireActual("../../utils/appointmentlock"),
  lockConsultationApproval: jest.fn(async () => ({})),
  renewApprovalLock: jest.fn(async () => undefined),
  unlockApproval: jest.fn(async () => undefined),
}));
jest.mock("../../lib/booking/approve-request", () => ({
  ...jest.requireActual("../../lib/booking/approve-request"),
  mintApprovalPaymentAfterCommit: jest.fn(async () => ({
    status: "not_delivered",
  })),
}));
jest.mock("../../lib/auth-helpers", () =>
  jest.requireActual("../fixtures/route-auth-mock").routeAuthMock(() => ({
    id: "u-expert",
    role: "CONSULTANT",
    consultantProfileId: "cp-1",
    consulteeProfileId: null,
  })),
);
jest.mock("../../lib/rate-limit", () => ({
  applyRateLimit: jest.fn(async () => null),
  eventMutationLimiter: {},
}));
jest.mock("../../actions/stream/chat/channel.action", () => ({
  createDirectMessageChannel: jest.fn(),
}));
jest.mock("../../lib/stream-logger", () => ({ streamLogger: {} }));
jest.mock("../../lib/stream-utils", () => ({ bookingOrgId: jest.fn() }));
jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));

import { PATCH } from "../../app/api/bookings/consultations/[consultationId]/route";

const approve = () =>
  PATCH(
    new NextRequest(`http://localhost/api/bookings/consultations/${ID}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "APPROVED" }),
    }),
    { params: Promise.resolve({ consultationId: ID }) } as never,
  );

beforeEach(() => {
  mockRevalidate.mockReset();
  mockTx.consultation.updateMany.mockClear();
});

it("refuses an unpaid approval whose time another booking now holds, and writes nothing", async () => {
  mockRevalidate.mockResolvedValue({
    isValid: false,
    errors: ["Conflicts with another booking"],
    warnings: [],
  });

  const res = await approve();

  expect(res.status).toBe(409);
  expect(await res.json()).toMatchObject({ code: "SCHEDULE_CONFLICT" });
  expect(mockTx.consultation.updateMany).not.toHaveBeenCalled();
});

it("starts the pay window when the time is still free", async () => {
  mockRevalidate.mockResolvedValue({ isValid: true, errors: [], warnings: [] });

  await approve();

  expect(mockRevalidate).toHaveBeenCalledWith(
    [START, new Date(START.getTime() + 1_800_000)],
    "u-expert",
    ["appt-1"],
    "u-learner",
    undefined,
    "cp-1",
  );
  expect(mockTx.consultation.updateMany).toHaveBeenCalledWith(
    expect.objectContaining({
      data: expect.objectContaining({ status: "APPROVED_PENDING_PAYMENT" }),
    }),
  );
});
