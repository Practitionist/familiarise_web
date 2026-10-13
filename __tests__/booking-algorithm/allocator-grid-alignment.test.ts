/**
 * The allocator may only emit starts a buyer could have picked.
 *
 * `lib/payments/utils/slot-validation::slotStartRefusal` refuses any
 * client-picked start that is not on the :00/:30 UTC grid (SLOT_NOT_ON_GRID),
 * and it runs in checkout and in request-for-approval. The allocator stepped 30
 * minutes from each row's OWN start, so a row published at 10:15 produced
 * candidate starts at 10:15 and 10:45 — a booking checkout would refuse, placed
 * by the server, for a buyer who could never have made it.
 *
 * The fix snaps the walk's anchor UP to the grid (`candidateStartsInRow`). The
 * buyer's 15-minute LEAD TIME is deliberately left alone: `slot-validation.ts`
 * documents that asymmetry on purpose (a server-picked slot may be imminent
 * where a client-picked one may not), and the allocator keeps its own
 * five-second `validateSlotsInFuture` buffer. These pins therefore assert
 * alignment and assert that the earliest-fit objective is untouched.
 */

import "./setup";

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    $transaction: jest.fn(),
    consultation: { findUnique: jest.fn() },
    subscription: { findUnique: jest.fn() },
    webinar: { findUnique: jest.fn() },
    class: { findUnique: jest.fn() },
    appointment: { findMany: jest.fn(), findFirst: jest.fn() },
    rescheduleRequest: { findFirst: jest.fn() },
  },
  ALLOCATION_TX_MAX_WAIT_MS: 8000,
  ALLOCATION_TX_TIMEOUT_MS: 30000,
}));

jest.mock("../../utils/appointmentlock", () => ({
  lockAutoAllocate: jest
    .fn()
    .mockResolvedValue({ key: "mock-key", value: "mock-value" }),
  unlockAutoAllocate: jest.fn().mockResolvedValue(undefined),
  lockConsulteeBooking: jest
    .fn()
    .mockResolvedValue({ key: "mock-consultee-key", value: "mock-value" }),
  unlockConsulteeBooking: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("@sentry/nextjs", () => ({
  __esModule: true,
  addBreadcrumb: jest.fn(),
  captureException: jest.fn(),
  captureMessage: jest.fn(),
  withScope: jest.fn(),
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const mockValidateFn = jest.fn();
const mockRevalidateConflictsFn = jest.fn();
jest.mock("../../utils/scheduling-engine/ScheduleValidationService", () => ({
  ...jest.requireActual(
    "../../utils/scheduling-engine/ScheduleValidationService",
  ),
  ScheduleValidationService: jest.fn().mockImplementation(() => ({
    validate: mockValidateFn,
    revalidateConflicts: mockRevalidateConflictsFn,
  })),
}));

import prisma from "@/lib/prisma";
import { SchedulingService } from "@/utils/scheduling-engine/SchedulingService";
import { slotStartRefusal } from "@/lib/payments/utils/slot-validation";
import { ScheduleType } from "@prisma/client";

const base = prisma as unknown as Record<string, Record<string, jest.Mock>>;
const THIRTY_MIN_MS = 30 * 60 * 1000;

/** A CUSTOM row starting at `iso` and running for `hours`. */
function customRow(iso: string, hours: number, id = "custom-1") {
  const startsAt = new Date(iso);
  return {
    id,
    startsAt,
    endsAt: new Date(startsAt.getTime() + hours * 60 * 60 * 1000),
  };
}

function consultationWithRow(row: ReturnType<typeof customRow>) {
  return {
    id: "consult-1",
    consultationPlan: {
      consultantProfileId: "consultant-profile-1",
      durationInHours: 1,
      consultantProfile: {
        user: { id: "consultant-user-1", timezone: "UTC" },
        scheduleType: ScheduleType.CUSTOM,
        availabilityWindowsWeekly: [],
        availabilityWindowsCustom: [row],
      },
    },
    requestedBy: { user: { id: "consultee-1" } },
    appointment: null,
  };
}

const mockTx = {
  consultation: {
    findUnique: jest.fn(),
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
  },
  consultantProfile: {
    findFirst: jest.fn().mockResolvedValue({ id: "consultant-profile-1" }),
  },
  collaborator: { findMany: jest.fn().mockResolvedValue([]) },
  appointmentParticipant: {
    createMany: jest.fn().mockResolvedValue({ count: 1 }),
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
  },
  bookingStatusHistory: { create: jest.fn().mockResolvedValue({}) },
  appointment: {
    findUnique: jest.fn().mockResolvedValue(null),
    findMany: jest.fn().mockResolvedValue([]),
    findFirst: jest.fn().mockResolvedValue(null),
    create: jest.fn().mockResolvedValue({ id: "apt-1", occurrences: [] }),
    update: jest.fn().mockResolvedValue({ id: "apt-1", occurrences: [] }),
    deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
  },
  appointmentOccurrence: {
    findFirst: jest.fn().mockResolvedValue(null),
    updateMany: jest.fn(),
    deleteMany: jest.fn(),
    count: jest.fn().mockResolvedValue(0),
  },
  $executeRaw: jest.fn().mockResolvedValue(1),
};

/**
 * Every occurrence row the allocator handed the write transaction. #1554: one
 * row per CALL, carrying the call's real bounds, so a one-hour session is one
 * row and not two half-hour rows.
 */
function placedOccurrences(): { startsAt: Date; endsAt: Date }[] {
  const rows = mockTx.appointment.create.mock.calls.flatMap(
    (call) =>
      (
        call[0] as {
          data?: {
            occurrences?: { create?: { startsAt: Date; endsAt: Date }[] };
          };
        }
      ).data?.occurrences?.create ?? [],
  );
  const updated = mockTx.appointment.update.mock.calls.flatMap(
    (call) =>
      (
        call[0] as {
          data?: {
            occurrences?: { create?: { startsAt: Date; endsAt: Date }[] };
          };
        }
      ).data?.occurrences?.create ?? [],
  );
  return [...rows, ...updated];
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date("2025-01-01T00:00:00Z"));
  jest.spyOn(console, "warn").mockImplementation(() => {});
  jest.clearAllMocks();

  (prisma.$transaction as jest.Mock).mockImplementation(
    async (callback: (tx: unknown) => unknown) => callback(mockTx),
  );
  base.appointment = mockTx.appointment;
  base.consultation.findUnique = mockTx.consultation.findUnique;
  base.rescheduleRequest.findFirst.mockResolvedValue(null);

  mockValidateFn.mockResolvedValue({ isValid: true, errors: [], warnings: [] });
  mockRevalidateConflictsFn.mockResolvedValue({
    isValid: true,
    errors: [],
    warnings: [],
  });
});

afterEach(() => {
  jest.useRealTimers();
});

describe("a consultant's published grid is the allocator's grid", () => {
  async function allocateWithCustomRow(iso: string, hours: number) {
    mockTx.consultation.findUnique.mockResolvedValue(
      consultationWithRow(customRow(iso, hours)),
    );
    const result = await SchedulingService.allocate({
      eventType: "consultation",
      eventId: "consult-1",
      mode: "auto",
    });
    return { result, placed: placedOccurrences() };
  }

  it("emits only on-grid starts for an ALIGNED row, earliest first", async () => {
    const { result, placed } = await allocateWithCustomRow(
      "2025-01-06T09:00:00.000Z",
      4,
    );

    expect(result.success).toBe(true);
    expect(placed).toHaveLength(1);
    // The published row opens at 09:00, so the first placeable start is 09:00 —
    // not 09:30, not a later block that scores better.
    expect(new Date(placed[0].startsAt).toISOString()).toBe(
      "2025-01-06T09:00:00.000Z",
    );
    expect(new Date(placed[0].endsAt).toISOString()).toBe(
      "2025-01-06T10:00:00.000Z",
    );
    for (const row of placed) {
      expect(row.startsAt.getTime() % THIRTY_MIN_MS).toBe(0);
      expect(row.endsAt.getTime() % THIRTY_MIN_MS).toBe(0);
    }
  });

  it("places an OFF-GRID legacy row at its first on-grid start inside the row", async () => {
    // A legacy row published 10:15-14:15: never 10:15 (checkout refuses it) and
    // never 10:00 (outside the published hours).
    const { result, placed } = await allocateWithCustomRow(
      "2025-01-06T10:15:00.000Z",
      4,
    );

    expect(result.success).toBe(true);
    expect(placed).toHaveLength(1);
    expect(new Date(placed[0].startsAt).toISOString()).toBe(
      "2025-01-06T10:30:00.000Z",
    );
  });

  it("never emits a start the buyer path's own grid check would refuse", async () => {
    // The strongest form of the property: whatever the allocator places, the
    // buyer-side predicate accepts on the GRID. The lead-time half is
    // deliberately not asserted — the allocator keeps its own five-second
    // buffer (see the header), so only the grid half is claimed here.
    const { placed } = await allocateWithCustomRow(
      "2025-01-06T09:00:00.000Z",
      8,
    );

    expect(placed.length).toBeGreaterThan(0);
    for (const row of placed) {
      expect(
        slotStartRefusal(new Date(row.startsAt), new Date(0))?.code ??
          "on-grid",
      ).not.toBe("SLOT_NOT_ON_GRID");
    }
  });

  it("leaves the earliest-fit objective alone: still the FIRST placeable start", async () => {
    const { placed } = await allocateWithCustomRow(
      "2025-01-06T09:00:00.000Z",
      4,
    );

    expect(new Date(placed[0].startsAt).toISOString()).toBe(
      "2025-01-06T09:00:00.000Z",
    );
  });
});
