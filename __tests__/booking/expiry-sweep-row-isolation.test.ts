/**
 * @jest-environment node
 */

/**
 * The stale-request sweep isolates each row, shares one start deadline across
 * its arms, and reports its failures once per run.
 */

import "../booking-algorithm/setup";

jest.mock("../../lib/payments/operations/booking-refund", () => ({
  __esModule: true,
  refundBookingPayment: jest.fn(),
}));

jest.mock("../../lib/prisma", () =>
  jest
    .requireActual("../fixtures/booking-expiry-test-doubles")
    .bookingExpiryPrismaModule(),
);

jest.mock("../../lib/cron/with-cron-lock", () => ({
  __esModule: true,
  withCronLock: (_key: string, _opts: unknown, fn: () => unknown) => fn(),
}));

const lapseApprovedRequest = jest.fn();
jest.mock("../../lib/booking/lapse-approved-request", () => ({
  lapseApprovedRequest: (...a: unknown[]) => lapseApprovedRequest(...a),
}));

const reportSentryError = jest.fn();
jest.mock("../../lib/observability/report", () => ({
  ...jest.requireActual("../../lib/observability/report"),
  reportSentryError: (...a: unknown[]) => reportSentryError(...a),
}));

import prisma from "../../lib/prisma";
import { expireStaleRequests } from "../../scripts/appointments/expire-stale-requests";
import { SWEEP_START_DEADLINE_MS } from "../../lib/cron/run-deadline";
import { AppointmentStatus, type Prisma } from "@prisma/client";

const consultations = prisma.consultation as unknown as {
  findMany: jest.Mock;
  updateMany: jest.Mock;
};

type CohortRead = {
  where?: Prisma.ConsultationWhereInput & {
    appointment?: { payment?: unknown };
  };
  orderBy?: { updatedAt?: string };
};
/** The unanswered-PENDING cohort read: its where names "no partial refund marker". */
const isStalePendingRead = (args: CohortRead) =>
  args.where?.status === AppointmentStatus.PENDING &&
  JSON.stringify(args.where.appointment?.payment ?? null).includes('"none"');
/** The awaiting-payment cohort read: oldest `updatedAt` first. */
const isPaymentPendingRead = (args: CohortRead) =>
  args.orderBy?.updatedAt === "asc";

/** One cohort read returns `ids`; every other consultation read is empty. */
function cohort(matches: (args: CohortRead) => boolean, ids: string[]) {
  consultations.findMany.mockImplementation(async (args: CohortRead) =>
    matches(args)
      ? ids.map((id) => ({ id, appointment: { id: `apt-${id}` } }))
      : [],
  );
}
const stalePendingConsultations = (ids: string[]) =>
  cohort(isStalePendingRead, ids);

const expiredWrites = () =>
  consultations.updateMany.mock.calls
    .map(([args]) => args)
    .filter((args) => args?.data?.status === AppointmentStatus.EXPIRED)
    .map((args) => args.where.id);

beforeEach(() => {
  jest.clearAllMocks();
  consultations.findMany.mockResolvedValue([]);
  consultations.updateMany.mockResolvedValue({ count: 1 });
  (prisma.subscription.findMany as jest.Mock).mockResolvedValue([]);
  (prisma.appointment.findMany as jest.Mock).mockResolvedValue([]);
});

it("a row that fails does not stop the rows after it, and the run reports the failures once", async () => {
  stalePendingConsultations(["cons-1", "cons-2", "cons-3", "cons-4"]);
  consultations.updateMany.mockImplementation(
    async ({ where }: { where: { id?: string } }) => {
      if (where.id === "cons-2" || where.id === "cons-3") {
        throw new Error(`connection reset on ${where.id}`);
      }
      return { count: 1 };
    },
  );

  const result = await expireStaleRequests();

  expect(expiredWrites()).toEqual(["cons-1", "cons-2", "cons-3", "cons-4"]);
  expect(result.consultationsExpired).toBe(2);
  expect(result.success).toBe(false);
  // One line for the arm and one Sentry event for the op, however many rows failed.
  expect(
    result.errors.filter((e) => /pending consultation/i.test(e)),
  ).toHaveLength(1);
  const reports = reportSentryError.mock.calls.filter(
    ([, opts]) => opts?.op === "expire-pending-consultation",
  );
  expect(reports).toHaveLength(1);
  expect(reports[0][1].extra).toMatchObject({
    count: 2,
    sample: [{ consultationId: "cons-2" }, { consultationId: "cons-3" }],
  });
});

it("the awaiting-payment arm isolates its rows the same way", async () => {
  cohort(isPaymentPendingRead, ["cons-a", "cons-b", "cons-c"]);
  lapseApprovedRequest.mockImplementation(
    async (_tx: unknown, args: { id: string }) => {
      if (args.id === "cons-b") throw new Error("connection reset");
      return { moved: 1, appointmentId: null };
    },
  );

  const result = await expireStaleRequests();

  expect(lapseApprovedRequest.mock.calls.map(([, args]) => args.id)).toEqual([
    "cons-a",
    "cons-b",
    "cons-c",
  ]);
  expect(result.paymentPendingExpired).toBe(2);
  expect(
    reportSentryError.mock.calls.filter(
      ([, opts]) => opts?.op === "expire-payment-pending-consultation",
    ),
  ).toHaveLength(1);
});

it("starts no arm once the run's deadline has passed", async () => {
  stalePendingConsultations(["cons-1"]);

  const result = await expireStaleRequests({
    startedAt: Date.now() - SWEEP_START_DEADLINE_MS - 1,
  });

  expect(consultations.findMany).not.toHaveBeenCalled();
  expect(prisma.subscription.findMany).not.toHaveBeenCalled();
  expect(result).toMatchObject({ success: true, consultationsExpired: 0 });
});

it("stops starting rows when the deadline passes inside an arm", async () => {
  stalePendingConsultations(["cons-1", "cons-2", "cons-3"]);
  const startedAt = Date.now();
  const now = jest.spyOn(Date, "now");
  consultations.updateMany.mockImplementation(async () => {
    // The first row's write runs the clock past the run's deadline.
    now.mockReturnValue(startedAt + SWEEP_START_DEADLINE_MS + 1);
    return { count: 1 };
  });

  try {
    const result = await expireStaleRequests({ startedAt });
    expect(expiredWrites()).toEqual(["cons-1"]);
    expect(result.consultationsExpired).toBe(1);
  } finally {
    now.mockRestore();
  }
});
