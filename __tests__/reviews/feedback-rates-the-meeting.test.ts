/**
 * @jest-environment node
 */

/**
 * #705 / #1554 — a rating belongs to the MEETING, and since the reset the
 * occurrence row IS the meeting: one row per held call, so the client posts
 * that row's id and there is no run anchor to resolve to. An in-person
 * 90-minute session is one UNVERIFIED row, which satisfies `heldOccurrence`
 * once, so one conversation can only ever take one rating per person per
 * level — and the whole-booking level is a second, separate row (NULL
 * occurrence), guarded by the `appointment_feedback_level_key` sidecar.
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
      create: jest.fn(async () => ({ id: "fb1" })),
      update: jest.fn(async () => ({ id: "fb1" })),
      findMany: jest.fn(),
      // #1300 — the route reads the stored row before writing, so it can stamp
      // `updatedAt` only when the opinion actually changed. No prior row here.
      findFirst: jest.fn(async () => null),
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
const mockedCreate = prisma.appointmentFeedback.create as jest.Mock;
const mockedUpdate = prisma.appointmentFeedback.update as jest.Mock;
const mockedFeedbackFindMany = prisma.appointmentFeedback.findMany as jest.Mock;
const mockedFeedbackFindFirst = prisma.appointmentFeedback
  .findFirst as jest.Mock;

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

function post(
  occurrenceId: string | null,
  rating = 4,
  comment?: string,
): NextRequest {
  return new NextRequest(`https://x.test/api/appointments/${APPT}/feedback`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      rating,
      ...(occurrenceId ? { occurrenceId } : {}),
      ...(comment ? { comment } : {}),
    }),
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
  // jest.clearAllMocks keeps the factory implementations; only per-test
  // overrides (mockResolvedValue) need resetting between cases.
  mockedFeedbackFindFirst.mockResolvedValue(null);
  mockedCreate.mockResolvedValue({ id: "fb1" });
  mockedUpdate.mockResolvedValue({ id: "fb1" });
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
    mockedFindFirst.mockResolvedValue({
      id: "slot-a",
      consultantProfileId: "cp-1",
    });

    const res = await POST(post("slot-a"), {
      params: Promise.resolve({ appointmentId: APPT }),
    });
    expect(res.status).toBe(200);

    // The prior-row read is by the (appointment, occurrence, user) triple —
    // the sidecar unique's key — and the create names the occurrence.
    expect(mockedFeedbackFindFirst.mock.calls[0][0].where).toEqual({
      appointmentId: APPT,
      appointmentOccurrenceId: "slot-a",
      userId: "u1",
    });
    const created = mockedCreate.mock.calls[0][0].data;
    expect(created.appointmentOccurrenceId).toBe("slot-a");
    // #1550 — the consultant rides on the row for the org rollup.
    expect(created.consultantProfileId).toBe("cp-1");
  });

  it("a re-submission for the same occurrence UPDATES rather than adding a rating", async () => {
    mockedFindFirst.mockResolvedValue({
      id: "slot-a",
      consultantProfileId: "cp-1",
    });
    await POST(post("slot-a"), {
      params: Promise.resolve({ appointmentId: APPT }),
    });
    mockedFeedbackFindFirst.mockResolvedValueOnce({
      id: "fb1",
      rating: 4,
      comment: null,
    });
    await POST(post("slot-a"), {
      params: Promise.resolve({ appointmentId: APPT }),
    });

    expect(mockedCreate).toHaveBeenCalledTimes(1);
    expect(mockedUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "fb1" } }),
    );
  });

  it("leaves a genuinely separate meeting on its own key", async () => {
    // A second occurrence in the same booking is a DIFFERENT meeting and must
    // not be folded into the first one's rating.
    mockedFindFirst.mockResolvedValue({
      id: "slot-z",
      consultantProfileId: "cp-1",
    });

    await POST(post("slot-z"), {
      params: Promise.resolve({ appointmentId: APPT }),
    });

    expect(mockedFeedbackFindFirst.mock.calls[0][0].where).toEqual(
      expect.objectContaining({ appointmentOccurrenceId: "slot-z" }),
    );
    expect(mockedCreate.mock.calls[0][0].data.appointmentOccurrenceId).toBe(
      "slot-z",
    );
  });
});

describe("a rating is about one call or the whole booking (#1554)", () => {
  beforeEach(() =>
    mockedFindFirst.mockResolvedValue({
      id: "slot-a",
      consultantProfileId: "cp-1",
    }),
  );

  it("lets one user hold an occurrence-level and an appointment-level row", async () => {
    await POST(post("slot-a"), {
      params: Promise.resolve({ appointmentId: APPT }),
    });
    // No occurrenceId: the whole booking. The prior-row read looks for a NULL
    // occurrence, so the call-level row above is not what it updates.
    const res = await POST(post(null), {
      params: Promise.resolve({ appointmentId: APPT }),
    });
    expect(res.status).toBe(200);

    expect(mockedFeedbackFindFirst.mock.calls[1][0].where).toEqual({
      appointmentId: APPT,
      appointmentOccurrenceId: null,
      userId: "u1",
    });
    const levels = mockedCreate.mock.calls.map(
      (c) => c[0].data.appointmentOccurrenceId,
    );
    expect(levels).toEqual(["slot-a", null]);
  });

  it("refuses a second appointment-level row from the same user", async () => {
    // The sidecar unique is NULLS NOT DISTINCT, so a racing second create for
    // the whole booking surfaces as P2002 and answers 409 rather than 500.
    mockedCreate.mockRejectedValueOnce(
      Object.assign(new Error("unique"), { code: "P2002" }),
    );
    const res = await POST(post(null), {
      params: Promise.resolve({ appointmentId: APPT }),
    });
    expect(res.status).toBe(409);
  });
});

describe("#1300 — only a changed opinion is an edit", () => {
  /** The stored row a re-submission lands on. */
  const stored = (rating: number, comment: string | null = null) =>
    mockedFeedbackFindFirst.mockResolvedValue({ id: "fb1", rating, comment });

  beforeEach(() =>
    mockedFindFirst.mockResolvedValue({
      id: "slot-a",
      consultantProfileId: "cp-1",
    }),
  );

  it("does not stamp updatedAt when the same rating is re-submitted", async () => {
    // `@updatedAt` was the original spelling and it could not express this at all:
    // Prisma stamps that attribute on create as well as update, so the column could
    // never hold the NULL that means "never edited since it was written", and a
    // double-tapped Save read as somebody changing their mind.
    stored(4);
    await POST(post("slot-a", 4), {
      params: Promise.resolve({ appointmentId: APPT }),
    });
    expect(mockedUpdate.mock.calls[0][0].data).not.toHaveProperty("updatedAt");
  });

  it("stamps updatedAt when the rating moves", async () => {
    // The case the org aggregate needs: it windows on `createdAt`, so a rating
    // written inside the window and rewritten from 5 to 1 later still reports in
    // that window and nothing else records that it moved.
    stored(5);
    await POST(post("slot-a", 1), {
      params: Promise.resolve({ appointmentId: APPT }),
    });
    expect(mockedUpdate.mock.calls[0][0].data.updatedAt).toBeInstanceOf(Date);
  });

  it("stamps updatedAt when only the comment is rewritten", async () => {
    stored(4, "Fine.");
    await POST(post("slot-a", 4, "Actually the call never connected."), {
      params: Promise.resolve({ appointmentId: APPT }),
    });
    expect(mockedUpdate.mock.calls[0][0].data.updatedAt).toBeInstanceOf(Date);
  });

  it("never stamps updatedAt on a first rating", async () => {
    // Nothing was edited: there was no previous opinion to change.
    mockedFeedbackFindFirst.mockResolvedValue(null);
    await POST(post("slot-a", 4), {
      params: Promise.resolve({ appointmentId: APPT }),
    });
    expect(mockedUpdate).not.toHaveBeenCalled();
    expect(mockedCreate.mock.calls[0][0].data).not.toHaveProperty("updatedAt");
  });
});
