/**
 * @jest-environment node
 */

/**
 * #705 — a rating belongs to the MEETING, and a meeting is a contiguous RUN of
 * 30-minute rows (#1061), not any single row.
 *
 * The client sends the run's anchor because that is what `OccurrenceVM.slotId`
 * carries, so the video path was safe by accident: only the anchor holds a
 * MeetingSession, so `heldSlot`'s attendance arm rejects every other row of the
 * run on its own. The OFFLINE path had no such backstop. An in-person 90-minute
 * session is three UNVERIFIED rows, each of which satisfies `heldSlot`
 * independently, so three separate ratings could be stored for one conversation
 * and the org quality aggregate would count all three.
 *
 * The route now resolves whatever row it is given back to its run's anchor,
 * which is already "the only row the video room may ever be keyed to". These
 * pin that the unique key is the anchor no matter which row is submitted.
 */

jest.mock("@sentry/nextjs", () => ({
  __esModule: true,
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

// Fully mocked, not half-mocked: `requireActual` here pulls lib/auth-server ->
// better-auth, whose ESM the jest transform will not take. These tests never
// exercise the authz-error mapping, so the real module buys nothing.
jest.mock("../../lib/api/appointment-access", () => ({
  __esModule: true,
  authorizeAppointment: jest.fn(),
  appointmentAuthzError: jest.fn(),
}));

jest.mock("../../lib/data/appointment-detail", () => ({
  __esModule: true,
  appointmentRaterRole: jest.fn(),
}));

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    appointmentOccurrence: { findFirst: jest.fn(), findMany: jest.fn() },
    appointmentFeedback: {
      upsert: jest.fn(),
      findMany: jest.fn(),
      // #1300 — the route reads the stored row before the upsert, so it can stamp
      // `updatedAt` only when the opinion actually changed. No prior row here.
      findUnique: jest.fn(async () => null),
    },
  },
}));

import { NextRequest } from "next/server";
import prisma from "../../lib/prisma";
import { authorizeAppointment } from "../../lib/api/appointment-access";
import { appointmentRaterRole } from "../../lib/data/appointment-detail";
import {
  GET,
  POST,
} from "../../app/api/appointments/[appointmentId]/feedback/route";

const mockedAuthorize = authorizeAppointment as jest.Mock;
const mockedRaterRole = appointmentRaterRole as jest.Mock;
const mockedFindFirst = prisma.appointmentOccurrence.findFirst as jest.Mock;
const mockedFindMany = prisma.appointmentOccurrence.findMany as jest.Mock;
const mockedUpsert = prisma.appointmentFeedback.upsert as jest.Mock;
const mockedFeedbackFindMany = prisma.appointmentFeedback.findMany as jest.Mock;
const mockedFeedbackFindUnique = prisma.appointmentFeedback
  .findUnique as jest.Mock;

const APPT = "appt-offline-90";

/** An in-person 90-minute session: ONE UNVERIFIED occurrence row (#1554). */
const RUN = [
  {
    id: "slot-a",
    appointmentId: APPT,
    startsAt: new Date("2026-08-01T10:00:00.000Z"),
    endsAt: new Date("2026-08-01T11:30:00.000Z"),
    isTentative: false,
    completionStatus: "UNVERIFIED",
  },
];

function post(slotId: string, rating = 4, comment?: string): NextRequest {
  return new NextRequest(`https://x.test/api/appointments/${APPT}/feedback`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ rating, slotId, ...(comment ? { comment } : {}) }),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedAuthorize.mockResolvedValue({
    userId: "u1",
    isOrgParty: false,
    organizationId: null,
    detail: {},
  });
  mockedRaterRole.mockReturnValue("CONSULTEE");
  mockedFindMany.mockResolvedValue(RUN);
  mockedUpsert.mockResolvedValue({ id: "fb1" });
});

describe("#1540 — one read for the whole booking", () => {
  /** #1554 — the subscription shape is ONE wrapper; there are no siblings. */
  const withSiblings = {
    userId: "u1",
    isOrgParty: false,
    organizationId: null,
    detail: {
      appointment: { id: APPT },
    },
  };

  const get = (url: string) =>
    GET(new NextRequest(url), {
      params: Promise.resolve({ appointmentId: APPT }),
    });

  beforeEach(() => {
    mockedAuthorize.mockResolvedValue(withSiblings);
    mockedFeedbackFindMany.mockResolvedValue([]);
    mockedFindMany.mockResolvedValue([]);
  });

  it("covers the whole booking under scope=booking with one row", async () => {
    // #1554 — the booking IS the one appointment, so the widened scope reads
    // the same id; the parameter is still accepted for older callers.
    await get(`http://x/api/appointments/${APPT}/feedback?scope=booking`);

    const ids = { in: [APPT] };
    expect(mockedFindMany.mock.calls[0][0].where.appointmentId).toEqual(ids);
    expect(mockedFeedbackFindMany.mock.calls[0][0].where.appointmentId).toEqual(
      ids,
    );
  });

  it("still answers for one appointment when the scope is not asked for", async () => {
    // The narrow read stays the default: a caller that wants one booking's own
    // ratings must not silently receive its siblings'. Expressed as a
    // single-element `in` rather than an equality so the query shape is the same
    // either way — Prisma emits `IN (...)`, which uses the same index as `=`.
    await get(`http://x/api/appointments/${APPT}/feedback`);
    expect(mockedFindMany.mock.calls[0][0].where.appointmentId).toEqual({
      in: [APPT],
    });
    expect(mockedFeedbackFindMany.mock.calls[0][0].where.appointmentId).toEqual(
      { in: [APPT] },
    );
  });

  it("has no tombstone to filter on: a private rating is excluded, never removed", async () => {
    // #1562 dropped `AppointmentFeedback.deletedAt` — it had no writer and nobody
    // is protected by hiding a staff-only note; ratings protection is
    // `excludedFromAggregateAt`, which the aggregates filter and this read does not.
    await get(`http://x/api/appointments/${APPT}/feedback?scope=booking`);
    expect(mockedFeedbackFindMany.mock.calls[0][0].where).not.toHaveProperty(
      "deletedAt",
    );
  });
});

describe("a rating identifies the meeting — the occurrence row (#1554)", () => {
  it("keys the rating on the submitted occurrence", async () => {
    mockedFindFirst.mockResolvedValue({ id: "slot-a" });

    const res = await POST(post("slot-a"), {
      params: Promise.resolve({ appointmentId: APPT }),
    });
    expect(res.status).toBe(200);

    const args = mockedUpsert.mock.calls[0][0];
    expect(
      args.where.appointmentOccurrenceId_userId.appointmentOccurrenceId,
    ).toBe("slot-a");
    expect(args.create.appointmentOccurrenceId).toBe("slot-a");
  });

  it("a re-submission for the same occurrence UPDATES rather than adding a rating", async () => {
    mockedFindFirst.mockResolvedValue({ id: "slot-a" });
    await POST(post("slot-a"), {
      params: Promise.resolve({ appointmentId: APPT }),
    });
    await POST(post("slot-a"), {
      params: Promise.resolve({ appointmentId: APPT }),
    });

    // Same unique key both times, so the upsert collapses them into one row.
    const keys = mockedUpsert.mock.calls.map(
      (c) => c[0].where.appointmentOccurrenceId_userId.appointmentOccurrenceId,
    );
    expect(keys).toEqual(["slot-a", "slot-a"]);
  });

  it("leaves a genuinely separate meeting on its own key", async () => {
    // A second occurrence in the same booking is a DIFFERENT meeting and must
    // not be folded into the first one's rating.
    const later = {
      id: "slot-z",
      appointmentId: APPT,
      startsAt: new Date("2026-08-08T10:00:00.000Z"),
      endsAt: new Date("2026-08-08T11:30:00.000Z"),
      isTentative: false,
      completionStatus: "UNVERIFIED",
    };
    mockedFindMany.mockResolvedValue([...RUN, later]);
    mockedFindFirst.mockResolvedValue({ id: "slot-z" });

    await POST(post("slot-z"), {
      params: Promise.resolve({ appointmentId: APPT }),
    });

    const args = mockedUpsert.mock.calls[0][0];
    expect(
      args.where.appointmentOccurrenceId_userId.appointmentOccurrenceId,
    ).toBe("slot-z");
  });
});

describe("#1300 — only a changed opinion is an edit", () => {
  /** The stored row a re-submission lands on. */
  const stored = (rating: number, comment: string | null = null) =>
    mockedFeedbackFindUnique.mockResolvedValue({ rating, comment });

  beforeEach(() => mockedFindFirst.mockResolvedValue({ id: "slot-a" }));

  it("does not stamp updatedAt when the same rating is re-submitted", async () => {
    // `@updatedAt` was the original spelling and it could not express this at all:
    // Prisma stamps that attribute on create as well as update, so the column could
    // never hold the NULL that means "never edited since it was written", and a
    // double-tapped Save read as somebody changing their mind.
    stored(4);
    await POST(post("slot-a", 4), {
      params: Promise.resolve({ appointmentId: APPT }),
    });
    expect(mockedUpsert.mock.calls[0][0].update).not.toHaveProperty(
      "updatedAt",
    );
  });

  it("stamps updatedAt when the rating moves", async () => {
    // The case the org aggregate needs: it windows on `createdAt`, so a rating
    // written inside the window and rewritten from 5 to 1 later still reports in
    // that window and nothing else records that it moved.
    stored(5);
    await POST(post("slot-a", 1), {
      params: Promise.resolve({ appointmentId: APPT }),
    });
    expect(mockedUpsert.mock.calls[0][0].update.updatedAt).toBeInstanceOf(Date);
  });

  it("stamps updatedAt when only the comment is rewritten", async () => {
    stored(4, "Fine.");
    await POST(post("slot-a", 4, "Actually the call never connected."), {
      params: Promise.resolve({ appointmentId: APPT }),
    });
    expect(mockedUpsert.mock.calls[0][0].update.updatedAt).toBeInstanceOf(Date);
  });

  it("never stamps updatedAt on a first rating", async () => {
    // Nothing was edited: there was no previous opinion to change.
    mockedFeedbackFindUnique.mockResolvedValue(null);
    await POST(post("slot-a", 4), {
      params: Promise.resolve({ appointmentId: APPT }),
    });
    expect(mockedUpsert.mock.calls[0][0].update).not.toHaveProperty(
      "updatedAt",
    );
    expect(mockedUpsert.mock.calls[0][0].create).not.toHaveProperty(
      "updatedAt",
    );
  });
});
