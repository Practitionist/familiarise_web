/**
 * @jest-environment node
 */

// The signed .ics link: a paid, unrefunded seat only, one 404 for every refusal, no video link.

jest.mock("../../lib/rate-limit", () => ({
  __esModule: true,
  applyRateLimit: jest.fn(async () => null),
  calendarLimiter: {},
  getClientIp: () => "203.0.113.7",
}));
const findFirst = jest.fn();
const seats: Row[] = [];
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    appointment: { findFirst: (...a: unknown[]) => findFirst(...a) },
    // Predicate-aware, so the seat query's paid-seat filter is really applied.
    appointmentParticipant: {
      findFirst: async ({ where }: { where: Where }) =>
        seats.find((row) => matchesWhere(row, where)) ?? null,
    },
  },
}));

import { NextRequest } from "next/server";
import { GET } from "../../app/api/calendar/[appointmentId]/route";
import { calendarLinks } from "../../lib/appointments/calendar-links";
import { paidParticipant } from "../../lib/booking/participants";
import { matchesWhere, type Row, type Where } from "../fixtures/mem-db";

function paidSeat(refunds: { amountPaise: number; status: string }[]) {
  return {
    appointmentId: "appt-1",
    userId: "buyer",
    role: "CONSULTEE",
    status: "CONFIRMED",
    paymentId: "pay-1",
    payment: {
      paymentStatus: "SUCCEEDED",
      amount: 118_000,
      paymentIntent: "order_1",
      refunds,
    },
  };
}

const startsAt = new Date(Date.now() + 48 * 3600_000);
const links = calendarLinks({
  appointmentId: "appt-1",
  userId: "buyer",
  title: "Deep work",
  startsAt,
});

function occurrence(over: {
  completionStatus?: string;
  deletedAt?: Date | null;
}) {
  return {
    ordinal: 1,
    startsAt,
    endsAt: null,
    updatedAt: new Date("2026-11-20T04:30:00Z"),
    isTentative: false,
    completionStatus: "SCHEDULED",
    deletedAt: null,
    ...over,
  };
}

function get(url: string, appointmentId = "appt-1") {
  return GET(new NextRequest(url), {
    params: Promise.resolve({ appointmentId }),
  });
}

beforeEach(() => {
  seats.splice(0, seats.length, paidSeat([]));
  findFirst.mockReset();
  findFirst.mockResolvedValue({
    appointmentType: "WEBINAR",
    consultation: null,
    subscription: null,
    webinar: { webinarPlan: { title: "Deep work" } },
    class: null,
    trial: null,
    occurrences: [occurrence({})],
  });
});

it("serves the paid seat's sessions with the dashboard link and nothing else", async () => {
  const res = await get(links!.icsUrl);
  const body = await res.text();

  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toBe("private, no-store");
  expect(res.headers.get("content-type")).toContain("text/calendar");
  expect(body).toContain("SUMMARY:Deep work");
  // The entry is the booking's first session, whichever row carries it.
  expect(body).toContain("UID:appt-1-1@familiarise");
  expect(body).toContain("STATUS:CONFIRMED");
  expect(body).toContain("/dashboard/go/auto/appointments/appt-1");
  expect(body).not.toMatch(/meetings|stream|buyer/i);
  expect(findFirst.mock.calls[0][0].where).toMatchObject({
    id: "appt-1",
    deletedAt: null,
    participants: { some: { ...paidParticipant("buyer"), role: "CONSULTEE" } },
  });
  expect(links!.googleUrl).toContain("calendar.google.com");
});

it("a session cancelled on a seat that is still paid downloads as its cancellation, not a 404", async () => {
  findFirst.mockResolvedValue({
    appointmentType: "CLASS",
    consultation: null,
    subscription: null,
    webinar: null,
    class: { classPlan: { title: "Deep work" } },
    trial: null,
    occurrences: [occurrence({ completionStatus: "CANCELLED" })],
  });

  const res = await get(links!.icsUrl);
  const body = await res.text();

  expect(res.status).toBe(200);
  expect(body).toContain("METHOD:CANCEL");
  expect(body).toContain("STATUS:CANCELLED");
  expect(body).toContain("UID:appt-1-1@familiarise");
});

describe("a seat that ended because the booking was cancelled", () => {
  const cancelledBooking = {
    appointmentType: "WEBINAR",
    consultation: null,
    subscription: null,
    webinar: { webinarPlan: { title: "Deep work" } },
    class: null,
    trial: null,
    occurrences: [
      occurrence({ completionStatus: "CANCELLED", deletedAt: new Date() }),
    ],
  };

  it.each(["CANCELLED", "REFUNDED"])(
    "a %s seat downloads the cancellation only: the same entry, title and time, nothing else",
    async (status) => {
      seats.splice(0, seats.length, { ...paidSeat([]), status });
      findFirst.mockResolvedValue(cancelledBooking);

      const res = await get(links!.icsUrl);
      const body = await res.text();

      expect(res.status).toBe(200);
      expect(body).toContain("METHOD:CANCEL");
      expect(body).toContain("STATUS:CANCELLED");
      expect(body).toContain("UID:appt-1-1@familiarise");
      expect(body).toContain("SUMMARY:Deep work");
      expect(body).not.toContain("STATUS:CONFIRMED");
      // No way back into the booking and nothing about anyone else.
      expect(body).not.toMatch(/DESCRIPTION|URL:|dashboard|meetings|buyer/i);
    },
  );

  it("an ended seat never reads sessions that are still on", async () => {
    seats.splice(0, seats.length, { ...paidSeat([]), status: "CANCELLED" });
    // The attendee left a class that goes ahead: nothing of theirs was cancelled.
    findFirst.mockResolvedValue({
      ...cancelledBooking,
      occurrences: [occurrence({})],
    });

    expect((await get(links!.icsUrl)).status).toBe(404);
  });

  it("someone who never held a seat still gets the same 404", async () => {
    seats.splice(0, seats.length);
    findFirst.mockResolvedValue(cancelledBooking);

    const res = await get(links!.icsUrl);

    expect(res.status).toBe(404);
    expect(await res.text()).toBe("Not found");
  });

  it("the expert's own row on the booking is not a seat", async () => {
    seats.splice(0, seats.length, {
      ...paidSeat([]),
      role: "CONSULTANT",
      status: "CANCELLED",
    });
    findFirst.mockResolvedValue(cancelledBooking);

    expect((await get(links!.icsUrl)).status).toBe(404);
  });
});

it("answers a bad token, another booking and an unpaid seat with the same 404", async () => {
  const url = links!.icsUrl;
  const tampered = url.slice(0, -1) + (url.endsWith("0") ? "1" : "0");
  const responses = [await get(tampered), await get(links!.icsUrl, "appt-2")];
  findFirst.mockResolvedValue(null);
  responses.push(await get(links!.icsUrl));

  for (const res of responses) {
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(await res.text()).toBe("Not found");
  }
});

it.each([
  [
    "a full refund still pending",
    [{ amountPaise: 118_000, status: "PENDING" }],
    404,
  ],
  [
    "a completed full refund",
    [{ amountPaise: 118_000, status: "SUCCEEDED" }],
    404,
  ],
  ["a partial refund", [{ amountPaise: 50_000, status: "SUCCEEDED" }], 200],
])("answers %s with %i", async (_label, refunds, status) => {
  seats.splice(0, seats.length, paidSeat(refunds));
  expect((await get(links!.icsUrl)).status).toBe(status);
});

it("keeps serving a genuinely free seat", async () => {
  seats.splice(0, seats.length, {
    ...paidSeat([]),
    paymentId: null,
    payment: null,
  });
  expect((await get(links!.icsUrl)).status).toBe(200);
});
