/**
 * @jest-environment node
 */

/**
 * A user who removed attendees owns blocks the seat marks keep, and the mark's
 * foreign key is Restrict. Their own account deletion is erased in place, as a
 * held seat is, and a mark written between the check and the delete answers a
 * clear 409, never a raw foreign-key 500.
 */

const mockScrub = jest.fn(async () => ({ vendorFailures: [] as string[] }));
const mockLiveBookings = jest.fn(async () => ({ activeEventSeats: 0 }));
jest.mock("../../lib/compliance/erasure/scrub-user", () => ({
  derivePseudonym: () => "pseudo-1",
  eraseStreamPrincipalFootprint: jest.fn(async () => undefined),
  hasLiveBookings: (counts: Record<string, number>) =>
    Object.values(counts).some((n) => n > 0),
  hasMoneyInFlight: () => false,
  hostedBookingsForUser: jest.fn(async () => null),
  liveBookingsForUser: () => mockLiveBookings(),
  moneyInFlightForUser: jest.fn(async () => ({})),
  scrubUser: () => mockScrub(),
  soleOwnerOrganizationsForUser: jest.fn(async () => []),
}));
jest.mock("../../lib/auth-helpers", () => ({
  requireApiAuth: jest.fn(async () => ({
    session: { user: { id: "host-1", role: "CONSULTANT" } },
  })),
}));
jest.mock("../../lib/auth/step-up", () => ({
  requireFreshSession: () => null,
}));
jest.mock("../../lib/auth/session-revoke", () => ({
  revokeAllUserSessions: jest.fn(async () => ({ ended: [] })),
}));
jest.mock("../../lib/auth/session-access-log", () => ({
  detachSessionAccessLogs: jest.fn(async () => undefined),
  stampSessionEnds: jest.fn(async () => undefined),
}));
jest.mock("../../lib/novu/subscriber", () => ({
  deleteSubscriber: jest.fn(async () => true),
}));
jest.mock("../../lib/collaborators/ending", () => ({
  endCollaborationsForUser: jest.fn(async () => []),
  afterCollaborationEnded: jest.fn(async () => undefined),
}));
jest.mock("../../lib/support/erasure", () => ({
  supportRetainedHistoryCount: jest.fn(async () => 0),
}));
jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));

const marks = { count: 0, raceOnDelete: false };
const mockUserDelete = jest.fn(async () => {
  if (marks.raceOnDelete) {
    throw Object.assign(new Error("Foreign key constraint violated"), {
      code: "P2003",
      meta: { field_name: "AppointmentParticipant_removedByUserId_fkey" },
    });
  }
  return {};
});
jest.mock("../../lib/prisma", () => {
  const zero = { count: jest.fn(async () => 0) };
  const tx = {
    consentArtifact: { updateMany: jest.fn(async () => ({ count: 0 })) },
    user: { delete: () => mockUserDelete() },
  };
  return {
    __esModule: true,
    default: {
      user: { findUnique: jest.fn(async () => ({ id: "host-1" })) },
      payment: zero,
      referralCredit: zero,
      programAssignment: zero,
      erasureRequest: { ...zero, findFirst: jest.fn(async () => null) },
      appointmentParticipant: {
        count: jest.fn(async (args: { where: Record<string, unknown> }) =>
          "removedByUserId" in args.where ? marks.count : 0,
        ),
      },
      consultantProfile: { findFirst: jest.fn(async () => null) },
      $transaction: async (fn: (t: unknown) => unknown) => fn(tx),
    },
  };
});

import { NextRequest } from "next/server";
import { DELETE } from "@/app/api/user/[id]/route";

const del = () =>
  DELETE(new NextRequest("http://localhost/api/user/host-1"), {
    params: Promise.resolve({ id: "host-1" }),
  });

beforeEach(() => {
  jest.clearAllMocks();
  marks.count = 0;
  marks.raceOnDelete = false;
});

it("erases a remover's account in place, keeping the user row the marks point at", async () => {
  marks.count = 2;
  const res = await del();
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ softDeleted: true });
  expect(mockScrub).toHaveBeenCalled();
  expect(mockUserDelete).not.toHaveBeenCalled();
});

it("answers a mark written mid-delete with a clear 409, never a foreign-key 500", async () => {
  marks.raceOnDelete = true;
  const res = await del();
  expect(res.status).toBe(409);
  expect(await res.json()).toMatchObject({
    code: "ERASURE_BLOCKED_RETAINED_RECORDS",
  });
});

it("still hard-deletes an account with nothing to keep", async () => {
  const res = await del();
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({
    message: "User deleted successfully",
  });
  expect(mockUserDelete).toHaveBeenCalledTimes(1);
});

it("refuses a learner who still holds a class or webinar seat, with nothing erased", async () => {
  mockLiveBookings.mockResolvedValueOnce({ activeEventSeats: 1 });
  const res = await del();
  expect(res.status).toBe(409);
  expect(await res.json()).toMatchObject({
    code: "ERASURE_BLOCKED_ACTIVE_BOOKINGS",
    counts: { activeEventSeats: 1 },
  });
  expect(mockScrub).not.toHaveBeenCalled();
  expect(mockUserDelete).not.toHaveBeenCalled();
});
