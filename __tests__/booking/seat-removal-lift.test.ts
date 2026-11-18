/**
 * @jest-environment node
 */

/**
 * Lifting a removal: staff hold the new surface and pass step-up; the
 * organiser may lift only a plain removal; the mark is cleared by
 * compare-and-set, so a second lift changes nothing; and what both controls
 * send parses through the routes' own schemas.
 */

jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));
jest.mock("../../lib/observability/report", () => ({
  reportSentryError: jest.fn(),
  reportSentryMessage: jest.fn(),
}));
jest.mock("../../lib/api/after-safe", () => ({
  scheduleAfter: (fn: () => unknown) => fn(),
}));
const mockStale = { value: false };
jest.mock("../../lib/auth/step-up", () => ({
  requireFreshSession: () =>
    mockStale.value
      ? jest
          .requireActual<typeof import("next/server")>("next/server")
          .NextResponse.json({ code: "STEP_UP_REQUIRED" }, { status: 403 })
      : null,
}));
const mockViewer = { id: "staff-1", role: "STAFF" };
jest.mock("../../lib/auth-helpers", () => ({
  requireBackofficeSurface: async (surface: BackofficeSurface) =>
    jest
      .requireActual<typeof import("../../lib/auth/backoffice-permissions")>(
        "../../lib/auth/backoffice-permissions",
      )
      .hasBackofficePermission(mockViewer.role as UserRole, surface)
      ? { session: { user: { ...mockViewer } } }
      : {
          error: jest
            .requireActual<typeof import("next/server")>("next/server")
            .NextResponse.json({ code: "FORBIDDEN" }, { status: 403 }),
        },
}));
const mockSyncBlock = jest.fn(async () => undefined);
const mockPersistBlock = jest.fn(async () => new Date("2026-11-18T10:00:00Z"));
jest.mock("../../lib/stream/access-revocation", () => ({
  persistConductBlockInTx: () => mockPersistBlock(),
  syncConductCallBlock: () => mockSyncBlock(),
}));
const mockStageBell = jest.fn(async (_tx: unknown, args: unknown) => ({
  id: "bell-1",
  args,
}));
jest.mock("../../lib/novu/stage-bell", () => ({
  stageBell: (tx: unknown, args: unknown) => mockStageBell(tx, args),
}));
jest.mock("../../lib/novu/stage-then-attempt", () => ({
  flushNotificationsAfter: jest.fn(async () => undefined),
}));

/** One removed seat, in the shape `clearRemovalMarkTx` selects. */
const mockDb = {
  marked: true,
  conductCase: false,
  priceFree: true,
};
const mockCas = jest.fn();
const mockHistory = jest.fn();
const mockOpsRows: unknown[] = [];
function mockTx() {
  return {
    appointmentParticipant: {
      findFirst: async () =>
        mockDb.marked
          ? {
              id: "part-1",
              status: "CANCELLED",
              appointmentId: APPT,
              removedByUserId: "host-1",
              payment: mockDb.priceFree
                ? { paymentIntent: "free_1", amount: 0, originalAmount: 0 }
                : {
                    paymentIntent: "order_1",
                    amount: 50_000,
                    originalAmount: 50_000,
                  },
              appointment: {
                webinar: {
                  id: "web-1",
                  webinarPlan: { id: "plan-1", title: "Intro to Python" },
                },
                class: null,
              },
            }
          : null,
      findUnique: async () => ({
        id: "part-1",
        removedByUserId: mockDb.marked ? "host-1" : null,
      }),
      updateMany: async (args: unknown) => {
        mockCas(args);
        const count = mockDb.marked ? 1 : 0;
        mockDb.marked = false;
        return { count };
      },
    },
    supportCase: {
      findFirst: async () =>
        mockDb.conductCase
          ? { id: "case-1", createdAt: new Date("2026-11-17T10:00:00Z") }
          : null,
    },
    supportCaseDecision: { findFirst: async () => null },
    bookingStatusHistory: {
      findFirst: async () => null,
      createMany: async (args: unknown) => mockHistory(args),
    },
    opsActionLog: {
      create: async ({ data }: { data: unknown }) => {
        mockOpsRows.push(data);
        return { id: "log" };
      },
    },
  };
}
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    $transaction: async (fn: (tx: unknown) => unknown) => fn(mockTx()),
  },
}));

import { NextRequest } from "next/server";
import type { UserRole } from "@prisma/client";
import type { BackofficeSurface } from "@/lib/auth/backoffice-permissions";
import { hasBackofficePermission } from "@/lib/auth/backoffice-permissions";
import { POST as staffLift } from "@/app/api/staff/appointments/[appointmentId]/seats/lift/route";
import {
  liftSeatRemovalAsOrganiser,
  rejoinNoticeText,
} from "@/lib/booking/seat-removal-lift";
import { allowBackRequest } from "@/lib/events/seat-lift-request";
import { seatLiftDoor } from "@/components/dashboard/backoffice/money/seat-lift-door";
import { opsReasonSchema } from "@/lib/backoffice/ops-reason";
import {
  SeatLiftBodySchema,
  SeatLiftResponseSchema,
} from "@/schemas/seat-removal-lift";

const APPT = "8b2f6c1e-1d2a-4f3b-9c4d-5e6f7a8b9c0d";

const post = (body: unknown) =>
  staffLift(
    new NextRequest(
      `https://x.invalid/api/staff/appointments/${APPT}/seats/lift`,
      { method: "POST", body: JSON.stringify(body) },
    ),
    { params: Promise.resolve({ appointmentId: APPT }) },
  );
const REASON = "Learner apologised; host agreed to let them back";

beforeEach(() => {
  jest.clearAllMocks();
  Object.assign(mockDb, { marked: true, conductCase: false, priceFree: true });
  mockStale.value = false;
  mockViewer.role = "STAFF";
  mockOpsRows.length = 0;
});

describe("the staff lift door", () => {
  it("is granted to support and admin only", () => {
    for (const role of ["STAFF", "ADMIN"] as UserRole[]) {
      expect(
        hasBackofficePermission(role, "appointments.liftSeatRemoval"),
      ).toBe(true);
    }
    for (const role of ["CONSULTANT", "CONSULTEE"] as UserRole[]) {
      expect(
        hasBackofficePermission(role, "appointments.liftSeatRemoval"),
      ).toBe(false);
    }
  });

  it("refuses a role without the surface and a stale session, writing nothing", async () => {
    mockViewer.role = "CONSULTANT";
    expect((await post({ userId: "u-1", reason: REASON })).status).toBe(403);
    mockViewer.role = "STAFF";
    mockStale.value = true;
    const stale = await post({ userId: "u-1", reason: REASON });
    expect(stale.status).toBe(403);
    expect(await stale.json()).toMatchObject({ code: "STEP_UP_REQUIRED" });
    expect(mockCas).not.toHaveBeenCalled();
  });

  it("lifts a conduct removal, writes the unblock intent and the audit row, and answers its schema", async () => {
    mockDb.conductCase = true;
    const res = await post({ userId: "u-1", reason: REASON });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(
      SeatLiftResponseSchema.parse({ ...body, opsActionId: undefined }),
    ).toEqual({ lifted: true, rejoinPath: "REGISTER", conduct: true });
    expect(mockCas).toHaveBeenCalledWith({
      where: { id: "part-1", removedByUserId: { not: null } },
      data: { removedByUserId: null },
    });
    expect(mockHistory).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          entity: "SEAT",
          entityId: "part-1",
          reason: "block_lifted",
          actorUserId: "staff-1",
          fromStatus: "CANCELLED",
          toStatus: "CANCELLED",
        }),
      ],
    });
    expect(mockPersistBlock).toHaveBeenCalledTimes(1);
    expect(mockSyncBlock).toHaveBeenCalledTimes(1);
    // The audit row keeps who removed the seat and how, since the lift clears it.
    expect(mockOpsRows).toEqual([
      expect.objectContaining({
        surface: "appointments.liftSeatRemoval",
        reason: REASON,
        before: { removedByUserId: "host-1", removal: "CONDUCT" },
      }),
    ]);
  });

  it("answers a second lift of the same seat with REMOVAL_ALREADY_LIFTED", async () => {
    expect((await post({ userId: "u-1", reason: REASON })).status).toBe(200);
    const again = await post({ userId: "u-1", reason: REASON });
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({
      code: "REMOVAL_ALREADY_LIFTED",
    });
    expect(mockHistory).toHaveBeenCalledTimes(1);
  });

  it("tells a paid seat that support will help, and a price-free one that it can register", async () => {
    mockDb.priceFree = false;
    await post({ userId: "u-1", reason: REASON });
    expect(mockStageBell).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        recipients: ["u-1"],
        payload: expect.objectContaining({
          rejoinText: "Support will help you rejoin Intro to Python.",
        }),
      }),
    );
    expect(rejoinNoticeText("REGISTER", "Intro to Python")).toBe(
      "You can register for Intro to Python again.",
    );
  });
});

describe("the organiser lift door", () => {
  const lift = () =>
    liftSeatRemovalAsOrganiser({
      appointmentId: APPT,
      userId: "u-1",
      actorUserId: "host-1",
    });

  it("lifts a plain removal", async () => {
    await expect(lift()).resolves.toMatchObject({
      rejoinPath: "REGISTER",
      conduct: false,
    });
    expect(mockPersistBlock).not.toHaveBeenCalled();
  });

  it("refuses a conduct removal that stands and leaves the mark", async () => {
    mockDb.conductCase = true;
    await expect(lift()).rejects.toMatchObject({ code: "LIFT_NOT_ALLOWED" });
    expect(mockCas).not.toHaveBeenCalled();
    expect(mockDb.marked).toBe(true);
  });
});

describe("what the lift controls send", () => {
  it("the roster's Allow back parses through the organiser route's schema", () => {
    const { url, init } = allowBackRequest("class", "cls-1", "u-1");
    expect(url).toBe("/api/participants/class/cls-1/allow-back");
    expect(init.method).toBe("POST");
    expect(SeatLiftBodySchema.parse(JSON.parse(String(init.body)))).toEqual({
      userId: "u-1",
    });
  });

  it("the staff door's body, with its reason, parses through the staff route's schema", () => {
    const door = seatLiftDoor(APPT, {
      userId: "u-1",
      name: "Riya",
      removal: "CONDUCT",
      paidSeat: true,
    });
    expect(door.url).toBe(`/api/staff/appointments/${APPT}/seats/lift`);
    expect(door.description).toMatch(/can't be bought again on their own yet/);
    expect(
      SeatLiftBodySchema.extend({ reason: opsReasonSchema }).parse({
        ...door.body,
        reason: REASON,
      }),
    ).toEqual({ userId: "u-1", reason: REASON });
  });
});
