/**
 * @jest-environment node
 */

/**
 * A moderation report never unlocks a chat on its own: staff open ONE support
 * case for the reporter, on a booking both users share, and that door is
 * audited. The real backoffice matrix and 2FA gate run; only the session and
 * the database are faked.
 */

const mockSession: {
  user: { id: string; role: string; twoFactorEnabled: boolean };
} = { user: { id: "staff-1", role: "STAFF", twoFactorEnabled: true } };

jest.mock("@sentry/nextjs", () => ({
  captureException: jest.fn(),
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock("next/headers", () => ({ headers: async () => new Headers() }));
jest.mock("../../lib/auth-session-lookup", () => ({
  lookupSession: async () => ({ kind: "found", session: mockSession }),
}));
jest.mock("../../lib/api/after-safe", () => ({ scheduleAfter: jest.fn() }));
jest.mock("../../lib/meetings/mirror-room-chat", () => ({
  resolveCanonicalMeetingChannel: jest.fn(),
}));
jest.mock("../../lib/support/case-service", () => ({
  stageSupportCaseIntakeTx: jest.fn(async () => undefined),
}));

const REPORT = {
  id: "0b1c2d3e-aaaa-bbbb-cccc-000000000001",
  type: "MESSAGE",
  reason: "HARASSMENT_OR_ABUSE",
  description: "They kept messaging me after I asked them to stop.",
  contentText: "SECRET-REPORTED-MESSAGE-TEXT",
  reportedById: "reporter-1",
  targetUserId: "target-1",
  streamChannelCid: "messaging:dm-a-b",
  supportCase: null as null | { id: string; referenceNumber: string },
};

const APPOINTMENT = {
  id: "appt-1",
  appointmentType: "CONSULTATION",
  consultation: null,
  subscription: null,
  webinar: null,
  class: null,
};

type CreateArgs = { data: Record<string, unknown> };

const tx = {
  moderationReport: { findUnique: jest.fn() },
  appointment: { findFirst: jest.fn(), count: jest.fn() },
  supportCase: {
    findFirst: jest.fn(),
    create: jest.fn(async ({ data }: CreateArgs) => ({
      id: "case-1",
      ...data,
    })),
  },
  supportCaseCounter: { upsert: jest.fn(async () => ({ nextSeq: 43 })) },
  opsActionLog: {
    create: jest.fn(async (_args: CreateArgs) => ({ id: "ops-1" })),
  },
};

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    $transaction: jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
    moderationReport: { findUnique: jest.fn() },
    appointment: { findMany: jest.fn() },
  },
}));

import { NextRequest } from "next/server";
import prisma from "../../lib/prisma";
import { resolveCanonicalMeetingChannel } from "../../lib/meetings/mirror-room-chat";
import { stageSupportCaseIntakeTx } from "../../lib/support/case-service";
import {
  GET,
  POST,
} from "../../app/api/staff/moderation/reports/[reportId]/case/route";
import { OpsRefusal, refusalResponse } from "../../lib/backoffice/ops-refusal";
import {
  bookingPartyWhere,
  reportCaseDescription,
} from "../../lib/moderation/report-case";

const resolveChannel = resolveCanonicalMeetingChannel as jest.Mock;
const globalDb = prisma as unknown as {
  $transaction: jest.Mock;
  moderationReport: { findUnique: jest.Mock };
  appointment: { findMany: jest.Mock };
};

const params = { params: Promise.resolve({ reportId: REPORT.id }) };

const post = (body: Record<string, unknown> = {}) =>
  POST(
    new NextRequest(
      `https://x.test/api/staff/moderation/reports/${REPORT.id}/case`,
      {
        method: "POST",
        body: JSON.stringify({
          appointmentId: "appt-1",
          category: "SAFETY_CONCERN",
          reason: "reporter says they feel unsafe",
          ...body,
        }),
      },
    ),
    params as never,
  );

const get = () =>
  GET(
    new NextRequest(
      `https://x.test/api/staff/moderation/reports/${REPORT.id}/case`,
    ),
    params,
  );

const createdData = () => tx.supportCase.create.mock.calls[0][0].data;

beforeEach(() => {
  jest.clearAllMocks();
  mockSession.user = { id: "staff-1", role: "STAFF", twoFactorEnabled: true };
  tx.moderationReport.findUnique.mockResolvedValue({ ...REPORT });
  tx.appointment.findFirst.mockResolvedValue(APPOINTMENT);
  tx.appointment.count.mockResolvedValue(1);
  tx.supportCase.findFirst.mockResolvedValue(null);
  resolveChannel.mockResolvedValue({
    channelType: "messaging",
    channelId: "dm-a-b",
  });
});

describe("POST /api/staff/moderation/reports/[reportId]/case — authz", () => {
  it.each(["STAFF", "ADMIN"])("lets %s open a case", async (role) => {
    mockSession.user = { id: "op-1", role, twoFactorEnabled: true };
    const res = await post();
    expect(res.status).toBe(201);
  });

  it.each(["CONSULTANT", "CONSULTEE"])("refuses %s with 403", async (role) => {
    mockSession.user = { id: "u-1", role, twoFactorEnabled: true };
    const res = await post();
    expect(res.status).toBe(403);
    expect(globalDb.$transaction).not.toHaveBeenCalled();
  });

  it("answers 428 to an operator without two-factor", async () => {
    mockSession.user = {
      id: "staff-1",
      role: "STAFF",
      twoFactorEnabled: false,
    };
    const res = await post();
    expect(res.status).toBe(428);
    expect(globalDb.$transaction).not.toHaveBeenCalled();
  });

  it("refuses a door without a reason", async () => {
    const res = await post({ reason: "ok" });
    expect(res.status).toBe(400);
    expect(tx.supportCase.create).not.toHaveBeenCalled();
  });

  it("refuses a category outside the report-case set", async () => {
    const res = await post({ category: "CANCEL_REFUND" });
    expect(res.status).toBe(400);
  });
});

describe("POST — the case it opens", () => {
  it("opens one HUMAN case for the reporter, linked to the report and booking", async () => {
    const res = await post();
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      case: { id: "case-1", referenceNumber: "FAM-2026-000042" },
      opsActionId: expect.any(String),
    });
    expect(createdData()).toMatchObject({
      requesterUserId: "reporter-1",
      submitterUserId: "reporter-1",
      ownershipScope: "PERSONAL",
      organizationId: null,
      scopeKey: "APPOINTMENT:appt-1",
      appointmentId: "appt-1",
      moderationReportId: REPORT.id,
      activeChannel: "HUMAN",
      category: "SAFETY_CONCERN",
      priority: "URGENT",
      title: "Report about a booking chat",
      subjects: {
        create: [
          { subjectType: "APPOINTMENT", subjectId: "appt-1", isPrimary: true },
        ],
      },
    });
    expect(createdData().events).toMatchObject({
      create: [
        {
          actorId: "staff-1",
          kind: "CREATED",
          note: "From moderation report RPT-0B1C2D3E",
        },
      ],
    });
    expect(stageSupportCaseIntakeTx).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ id: "case-1" }),
      "SYSTEM",
    );
  });

  it("never copies the reported message text, or the target, into the case", async () => {
    await post();
    const serialised = JSON.stringify(createdData());
    expect(serialised).not.toContain("SECRET-REPORTED-MESSAGE-TEXT");
    expect(serialised).not.toContain("target-1");
    expect(createdData().description).toContain(REPORT.description);
    expect(
      reportCaseDescription({ ...REPORT, description: null }),
    ).not.toContain("SECRET");
  });

  it("triages a quality complaint at MEDIUM", async () => {
    await post({ category: "QUALITY_COMPLAINT" });
    expect(createdData()).toMatchObject({
      priority: "MEDIUM",
      category: "QUALITY_COMPLAINT",
      issueType: "SESSION_QUALITY_POOR",
    });
  });

  it("writes the ops row against the report, correlated to the case", async () => {
    await post();
    expect(tx.opsActionLog.create).toHaveBeenCalledTimes(1);
    expect(tx.opsActionLog.create.mock.calls[0][0]).toMatchObject({
      data: {
        actorUserId: "staff-1",
        actorRole: "STAFF",
        surface: "tickets.manage",
        action: "moderation.report.open-case",
        targetKind: "ModerationReport",
        targetId: REPORT.id,
        reason: "reporter says they feel unsafe",
        after: {
          caseId: "case-1",
          appointmentId: "appt-1",
          category: "SAFETY_CONCERN",
        },
        correlationId: "support-case:case-1",
      },
    });
  });
});

describe("POST — refusals", () => {
  const expectNothingWritten = () => {
    expect(tx.supportCase.create).not.toHaveBeenCalled();
    expect(tx.opsActionLog.create).not.toHaveBeenCalled();
  };

  it("404s an unknown report", async () => {
    tx.moderationReport.findUnique.mockResolvedValue(null);
    expect((await post()).status).toBe(404);
    expectNothingWritten();
  });

  it("refuses a second case for a report, naming the first", async () => {
    tx.moderationReport.findUnique.mockResolvedValue({
      ...REPORT,
      supportCase: { id: "case-0", referenceNumber: "FAM-2026-000007" },
    });
    const res = await post();
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      code: "REPORT_HAS_CASE",
      existingCase: {
        id: "case-0",
        referenceNumber: "FAM-2026-000007",
        caseKey: "c_case-0",
      },
    });
    expectNothingWritten();
  });

  it("maps a lost race on the one-case-per-report unique to the same refusal", async () => {
    tx.supportCase.create.mockRejectedValueOnce(
      Object.assign(new Error("Unique constraint failed"), {
        code: "P2002",
        meta: { target: ["moderationReportId"] },
      }),
    );
    const res = await post();
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "REPORT_HAS_CASE" });
    expect(tx.opsActionLog.create).not.toHaveBeenCalled();
  });

  it("refuses when the reporter and target are not both on the booking", async () => {
    tx.appointment.count.mockResolvedValue(0);
    const res = await post();
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "NOT_BOOKING_PARTIES" });
    expectNothingWritten();
  });

  it("checks both users' party predicates on the chosen booking", async () => {
    await post();
    const where = tx.appointment.count.mock.calls[0][0].where;
    expect(where).toMatchObject({
      id: "appt-1",
      deletedAt: null,
      AND: [bookingPartyWhere("reporter-1"), bookingPartyWhere("target-1")],
    });
  });

  it("refuses a booking whose chat is not the reported one", async () => {
    resolveChannel.mockResolvedValue({
      channelType: "messaging",
      channelId: "dm-other",
    });
    const res = await post();
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "CHANNEL_MISMATCH" });
    expect(resolveChannel).toHaveBeenCalledWith(APPOINTMENT, tx);
    expectNothingWritten();
  });

  it("refuses a trial booking for a message report: trials have no chat", async () => {
    tx.appointment.findFirst.mockResolvedValue({
      ...APPOINTMENT,
      appointmentType: "TRIAL",
    });
    const res = await post();
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "CHAT_DISABLED" });
    expectNothingWritten();
  });

  it("refuses rather than attaches when the reporter has an open case in that scope", async () => {
    tx.supportCase.findFirst.mockResolvedValue({
      id: "case-9",
      referenceNumber: "FAM-2026-000009",
    });
    const res = await post();
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      code: "OPEN_CASE_EXISTS",
      existingCase: { id: "case-9", referenceNumber: "FAM-2026-000009" },
    });
    expect(tx.supportCase.findFirst.mock.calls[0][0].where).toMatchObject({
      ownershipScope: "PERSONAL",
      organizationId: null,
      scopeKey: "APPOINTMENT:appt-1",
      requesterUserId: "reporter-1",
      submitterUserId: "reporter-1",
      category: "SAFETY_CONCERN",
      closedAt: null,
      deletedAt: null,
    });
    expectNothingWritten();
  });
});

describe("GET /api/staff/moderation/reports/[reportId]/case", () => {
  beforeEach(() => {
    globalDb.moderationReport.findUnique.mockResolvedValue({ ...REPORT });
  });

  it("lists bounded shared bookings and flags the ones whose chat differs", async () => {
    globalDb.appointment.findMany.mockResolvedValue([
      {
        ...APPOINTMENT,
        occurrences: [{ startsAt: new Date("2026-10-01T10:00:00Z") }],
        consultation: { consultationPlan: { title: "Career chat" } },
        trial: null,
      },
      {
        ...APPOINTMENT,
        id: "appt-2",
        occurrences: [],
        consultation: { consultationPlan: { title: "Other chat" } },
        trial: null,
      },
    ]);
    resolveChannel
      .mockResolvedValueOnce({ channelType: "messaging", channelId: "dm-a-b" })
      .mockResolvedValueOnce({ channelType: "messaging", channelId: "dm-x" });
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      linkedCase: null,
      candidates: [
        {
          id: "appt-1",
          type: "CONSULTATION",
          title: "Career chat",
          startsAt: "2026-10-01T10:00:00.000Z",
          chatMatchesReport: true,
        },
        {
          id: "appt-2",
          type: "CONSULTATION",
          title: "Other chat",
          startsAt: null,
          chatMatchesReport: false,
        },
      ],
    });
    expect(globalDb.appointment.findMany.mock.calls[0][0]).toMatchObject({
      take: 20,
      where: {
        deletedAt: null,
        AND: [bookingPartyWhere("reporter-1"), bookingPartyWhere("target-1")],
      },
    });
  });

  it("returns the linked case instead of candidates", async () => {
    globalDb.moderationReport.findUnique.mockResolvedValue({
      ...REPORT,
      supportCase: { id: "case-0", referenceNumber: "FAM-2026-000007" },
    });
    const res = await get();
    expect(await res.json()).toEqual({
      linkedCase: { id: "case-0", referenceNumber: "FAM-2026-000007" },
      candidates: [],
    });
    expect(globalDb.appointment.findMany).not.toHaveBeenCalled();
  });

  it("refuses a non-operator", async () => {
    mockSession.user = { id: "u-1", role: "CONSULTEE", twoFactorEnabled: true };
    expect((await get()).status).toBe(403);
  });
});

describe("bookingPartyWhere", () => {
  it("counts live seats, captured payers, plan consultants and accepted presenters", () => {
    const where = JSON.stringify(bookingPartyWhere("u-1"));
    expect(where).toContain('"status":{"in":["HELD","CONFIRMED","ATTENDED"]}');
    expect(where).toContain('"paymentStatus":"SUCCEEDED"');
    expect(where).toContain('"tier":"PRESENTER"');
    expect(where).toContain('"status":"ACCEPTED"');
  });
});

describe("OpsRefusal detail", () => {
  it("merges detail into the body without letting it override code or error", async () => {
    const res = refusalResponse(
      new OpsRefusal("X", "msg", 409, { code: "Y", error: "no", extra: 1 }),
    );
    expect(await res?.json()).toEqual({ code: "X", error: "msg", extra: 1 });
  });

  it("keeps the two-field body for a refusal without detail", async () => {
    const res = refusalResponse(new OpsRefusal("X", "msg"));
    expect(await res?.json()).toEqual({ code: "X", error: "msg" });
  });
});
