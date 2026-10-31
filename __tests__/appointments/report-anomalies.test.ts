/**
 * @jest-environment node
 */

/**
 * The server half of the booking-row boundary: impossible session times and
 * an approved booking with nothing to attend become one standing finding per
 * kind (deduped per id per day by `reportStandingFinding`), never one per row,
 * and a failing report never reaches the reader.
 */

jest.mock("../../lib/prisma", () => ({ __esModule: true, default: {} }));

const reportStandingFinding = jest.fn(
  async (_args: unknown, report: () => void) => {
    report();
    return true;
  },
);
jest.mock("../../lib/observability/standing-finding", () => ({
  __esModule: true,
  reportStandingFinding: (args: unknown, report: () => void) =>
    reportStandingFinding(args, report),
}));

const reportSentryError = jest.fn();
jest.mock("../../lib/observability/report", () => ({
  __esModule: true,
  reportSentryError: (...args: unknown[]) => reportSentryError(...args),
}));

import {
  bookingAnomalies,
  reportAppointmentAnomalies,
} from "@/lib/appointments/report-anomalies";

const at = (iso: string) => new Date(iso);
const ok = {
  id: "ok",
  startsAt: at("2026-09-07T10:00:00Z"),
  endsAt: at("2026-09-07T11:00:00Z"),
  completionStatus: "SCHEDULED",
  deletedAt: null,
};

beforeEach(() => jest.clearAllMocks());

describe("bookingAnomalies", () => {
  it("names impossible session times on any row", () => {
    expect(
      bookingAnomalies([
        {
          id: "appt-1",
          appointmentType: "WEBINAR",
          occurrences: [
            ok,
            {
              id: "inverted",
              startsAt: at("2026-09-07T12:00:00Z"),
              endsAt: at("2026-09-07T11:00:00Z"),
            },
          ],
        },
      ]),
    ).toEqual([{ kind: "ENDS_BEFORE_START", id: "inverted" }]);
  });

  it("flags an approved booking that lost every session, only when proposals are known", () => {
    const lost = {
      id: "appt-lost",
      appointmentType: "CONSULTATION",
      occurrences: [{ ...ok, completionStatus: "CANCELLED" }],
      consultation: { status: "APPROVED" },
    };
    expect(bookingAnomalies([lost])).toEqual([]);
    expect(bookingAnomalies([lost], { openRescheduleIds: new Set() })).toEqual([
      { kind: "NO_LIVE_SESSION", id: "appt-lost" },
    ]);
    // An open proposal owns the gap.
    expect(
      bookingAnomalies([lost], { openRescheduleIds: new Set(["appt-lost"]) }),
    ).toEqual([]);
  });

  it("does not flag a plan awaiting its first session, or a closed request", () => {
    const known = { openRescheduleIds: new Set<string>() };
    expect(
      bookingAnomalies(
        [
          {
            id: "appt-awaiting",
            appointmentType: "SUBSCRIPTION",
            occurrences: [],
            subscription: { status: "APPROVED" },
          },
          {
            id: "appt-cancelled",
            appointmentType: "CONSULTATION",
            occurrences: [{ ...ok, completionStatus: "CANCELLED" }],
            consultation: { status: "CANCELLED" },
          },
        ],
        known,
      ),
    ).toEqual([]);
  });
});

describe("reportAppointmentAnomalies", () => {
  it("reports one finding per kind carrying every id, and one Sentry warning each", async () => {
    await reportAppointmentAnomalies(
      [
        { kind: "ENDS_BEFORE_START", id: "o1" },
        { kind: "ENDS_BEFORE_START", id: "o2" },
        { kind: "NO_LIVE_SESSION", id: "a1" },
      ],
      "appointment-detail",
    );
    expect(reportStandingFinding).toHaveBeenCalledTimes(2);
    expect(reportStandingFinding).toHaveBeenCalledWith(
      expect.objectContaining({
        key: "appointment-data:ENDS_BEFORE_START",
        ids: ["o1", "o2"],
      }),
      expect.any(Function),
    );
    expect(reportStandingFinding).toHaveBeenCalledWith(
      expect.objectContaining({
        key: "appointment-data:NO_LIVE_SESSION",
        ids: ["a1"],
      }),
      expect.any(Function),
    );
    expect(reportSentryError).toHaveBeenCalledTimes(2);
    expect(reportSentryError.mock.calls[0][1]).toMatchObject({
      level: "warning",
      op: "appointment-detail",
    });
  });

  it("swallows a failed report so the reader keeps rendering", async () => {
    reportStandingFinding.mockRejectedValueOnce(new Error("db down"));
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    await expect(
      reportAppointmentAnomalies(
        [{ kind: "OVERLONG_SESSION", id: "o9" }],
        "availability-grid",
      ),
    ).resolves.toBeUndefined();
    warn.mockRestore();
  });

  it("does nothing for no anomalies", async () => {
    await reportAppointmentAnomalies([], "consultant-appointments");
    expect(reportStandingFinding).not.toHaveBeenCalled();
  });
});
