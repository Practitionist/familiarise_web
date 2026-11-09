/** @jest-environment node */
jest.mock("@sentry/nextjs", () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));
jest.mock("../../lib/novu/stage-bell", () => ({
  stageBell: jest.fn(async () => null),
}));
jest.mock("../../lib/email/deliver", () => ({
  stage: jest.fn(async () => null),
}));
jest.mock("../../lib/prisma", () => {
  const db = {
    supportCase: {
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      updateMany: jest.fn(),
    },
    supportCaseMessage: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
    },
    supportCaseEvent: { create: jest.fn() },
    user: {
      findMany: jest.fn(async () => [{ id: "staff" }]),
      findUnique: jest.fn(),
    },
    membership: { findUnique: jest.fn(), findMany: jest.fn(async () => []) },
    appointment: { findMany: jest.fn(async () => []) },
    consultantProfile: { findMany: jest.fn(async () => []) },
    supportCaseCounter: { upsert: jest.fn(async () => ({ nextSeq: 2 })) },
    $transaction: jest.fn(),
  };
  db.$transaction.mockImplementation((callback: (tx: typeof db) => unknown) =>
    callback(db),
  );
  return {
    __esModule: true,
    default: db,
    ALLOCATION_TX_MAX_WAIT_MS: 1000,
    ALLOCATION_TX_TIMEOUT_MS: 1000,
  };
});
import { Prisma } from "@prisma/client";
import prisma from "../../lib/prisma";
import {
  appendSupportCaseTurn,
  createOrReuseSupportCase,
  readSupportCaseForViewer,
  submitSupportCaseCsat,
  supportMonthlyComplianceReport,
  stageSupportCaseIntakeTx,
} from "../../lib/support/case-service";
import { supportDeadline } from "../../lib/support/deadline-policy";
import { slaStateOf } from "../../lib/support/sla";
import { stageBell } from "../../lib/novu/stage-bell";
import { stage as stageEmail } from "../../lib/email/deliver";
import { supportRequestHref } from "../../lib/novu/resolve-href";
const cases = prisma.supportCase;
const now = new Date("2026-10-20T00:00:00Z");
const record = (overrides: Record<string, unknown> = {}) => ({
  id: "case",
  referenceNumber: "FAM-2026-000001",
  title: "Help",
  description: "Complaint",
  category: "GENERAL",
  status: "OPEN",
  requesterUserId: "customer",
  submitterUserId: "customer",
  ownershipScope: "PERSONAL",
  organizationId: null,
  appointmentId: null,
  externalRequesterEmail: null,
  assignedToId: null,
  createdAt: now,
  updatedAt: now,
  awaitingUserSince: null,
  pausedSeconds: 0,
  lastMessageAt: now,
  messageSeq: 1,
  deletedAt: null,
  resolvedAt: null,
  closedAt: null,
  csatRating: null,
  messages: [],
  subjects: [],
  events: [],
  ...overrides,
});

const presenterBooking = () => ({
  id: "appt-1",
  participants: [],
  consultation: null,
  subscription: null,
  webinar: {
    webinarPlan: {
      consultantProfileId: null,
      collaborators: [{ consultantProfileId: "presenter-profile" }],
    },
  },
  class: null,
  payment: [],
});

const mockPresenter = () => {
  (prisma.appointment.findMany as jest.Mock).mockResolvedValueOnce([
    presenterBooking(),
  ]);
  (prisma.consultantProfile.findMany as jest.Mock).mockResolvedValueOnce([
    { id: "presenter-profile", user: { id: "presenter" } },
  ]);
};

beforeEach(() => {
  jest.clearAllMocks();
  (cases.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
  (cases.findUnique as jest.Mock).mockResolvedValue(record());
  (cases.findUniqueOrThrow as jest.Mock).mockResolvedValue({ messageSeq: 2 });
  (prisma.supportCaseMessage.findUnique as jest.Mock).mockResolvedValue(null);
  (prisma.supportCaseMessage.create as jest.Mock).mockResolvedValue({
    id: "message",
    seq: 2,
  });
  (prisma.membership.findMany as jest.Mock).mockResolvedValue([]);
  (prisma.appointment.findMany as jest.Mock).mockReset().mockResolvedValue([]);
  (prisma.consultantProfile.findMany as jest.Mock)
    .mockReset()
    .mockResolvedValue([]);
  (prisma.user.findMany as jest.Mock)
    .mockReset()
    .mockResolvedValue([{ id: "staff" }]);
});
it("replays an intake only within its submitting party", async () => {
  (cases.findFirst as jest.Mock).mockResolvedValueOnce(record());
  const result = await createOrReuseSupportCase(
    {
      title: "Help",
      description: "Complaint",
      category: "GENERAL",
      requesterUserId: "customer",
      submitterUserId: "customer",
      clientIntakeId: "same-browser-retry",
    },
    now,
  );
  expect(result.reused).toBe(true);
  expect(cases.findFirst).toHaveBeenCalledWith(
    expect.objectContaining({
      where: {
        submitterUserId: "customer",
        clientIntakeId: "same-browser-retry",
      },
    }),
  );
  expect(cases.create).not.toHaveBeenCalled();
});
it("returns the winning case when a concurrent intake with the same retry key commits first", async () => {
  const duplicate = new Prisma.PrismaClientKnownRequestError(
    "Unique constraint failed",
    { code: "P2002", clientVersion: "test" },
  );
  (prisma.$transaction as jest.Mock).mockRejectedValueOnce(duplicate);
  const winner = record({ id: "winner" });
  (cases.findFirst as jest.Mock).mockResolvedValueOnce(winner);
  const result = await createOrReuseSupportCase(
    {
      title: "Help",
      description: "Complaint",
      category: "GENERAL",
      requesterUserId: "customer",
      submitterUserId: "customer",
      clientIntakeId: "double-click",
    },
    now,
  );
  expect(result).toMatchObject({
    reused: true,
    dedupeReason: "client_intake_id",
    supportCase: { id: "winner" },
  });
  expect(cases.findFirst).toHaveBeenCalledWith(
    expect.objectContaining({
      where: { clientIntakeId: "double-click", submitterUserId: "customer" },
    }),
  );
  expect(cases.create).not.toHaveBeenCalled();
});
it("returns the original turn when a browser retries a customer reply", async () => {
  (prisma.supportCaseMessage.findUnique as jest.Mock).mockResolvedValueOnce({
    seq: 2,
  });
  (prisma.supportCaseMessage.findMany as jest.Mock).mockResolvedValueOnce([
    { id: "already-sent", seq: 2 },
  ]);
  const result = await appendSupportCaseTurn(
    {
      caseId: "case",
      authorUserId: "customer",
      sender: "USER",
      body: "Retry",
      clientTurnId: "turn",
      isInternal: false,
    },
    now,
  );
  expect(result).toMatchObject({ ok: true, replayed: true });
  expect(prisma.supportCaseMessage.create).not.toHaveBeenCalled();
  expect(prisma.supportCaseMessage.findMany).toHaveBeenCalledWith(
    expect.objectContaining({
      where: { caseId: "case", seq: { gte: 2 }, isInternal: false },
    }),
  );
});
it("rejects a stale public reply instead of overwriting a concurrent resolution", async () => {
  (cases.updateMany as jest.Mock).mockResolvedValueOnce({ count: 0 });
  const result = await appendSupportCaseTurn(
    {
      caseId: "case",
      authorUserId: "staff",
      sender: "AGENT",
      body: "Reply",
      expectedLastMessageAt: now.toISOString(),
      isInternal: false,
    },
    now,
  );
  expect(result).toMatchObject({ ok: false, status: 409 });
  expect(prisma.supportCaseMessage.create).not.toHaveBeenCalled();
  expect(cases.updateMany).toHaveBeenCalledWith(
    expect.objectContaining({
      where: expect.objectContaining({ status: "OPEN", updatedAt: now }),
    }),
  );
});
it("stores a presenter reply as a provider message without reopening or claiming the case", async () => {
  mockPresenter();
  (cases.findUnique as jest.Mock).mockResolvedValueOnce(
    record({
      status: "RESOLVED",
      resolvedAt: now,
      assignedToId: "staff",
      appointmentId: "appt-1",
    }),
  );
  const result = await appendSupportCaseTurn(
    {
      caseId: "case",
      authorUserId: "presenter",
      sender: "AGENT",
      actorKind: "PRESENTER",
      body: "Reply",
      isInternal: false,
    },
    now,
  );
  expect(result).toMatchObject({ ok: true });
  expect(cases.updateMany).toHaveBeenCalledWith({
    where: { id: "case" },
    data: { messageSeq: { increment: 1 }, lastMessageAt: now },
  });
  const update = (cases.updateMany as jest.Mock).mock.calls[0][0];
  expect(update.data).not.toHaveProperty("firstAgentReplyAt");
  expect(update.data).not.toHaveProperty("assignedToId");
  expect(update.data).not.toHaveProperty("awaitingUserSince");
  expect(update.data).not.toHaveProperty("status");
  expect(prisma.supportCaseEvent.create).not.toHaveBeenCalled();
  expect(prisma.supportCaseMessage.create).toHaveBeenCalledWith(
    expect.objectContaining({
      data: expect.objectContaining({
        sender: "AGENT",
        metadata: { actorKind: "PRESENTER" },
      }),
    }),
  );
});
it.each([
  [
    "an anonymous external requester's case",
    { externalRequesterEmail: "x@y.invalid" },
  ],
  ["a safety concern", { category: "SAFETY_CONCERN" }],
  ["a quality complaint", { category: "QUALITY_COMPLAINT" }],
  ["a sensitive issue type", { issueType: "WRONG_CONSULTANT" }],
])("refuses a presenter reply on %s", async (_label, overrides) => {
  (cases.findUnique as jest.Mock).mockResolvedValueOnce(
    record({ appointmentId: "appt-1", ...overrides }),
  );
  const result = await appendSupportCaseTurn(
    {
      caseId: "case",
      authorUserId: "presenter",
      sender: "AGENT",
      actorKind: "PRESENTER",
      body: "Reply",
      isInternal: false,
    },
    now,
  );
  expect(result).toMatchObject({ ok: false, status: 403, code: "FORBIDDEN" });
  expect(prisma.supportCaseMessage.create).not.toHaveBeenCalled();
});
it("refuses a presenter reply from someone who does not present the booking", async () => {
  mockPresenter();
  (cases.findUnique as jest.Mock).mockResolvedValueOnce(
    record({ appointmentId: "appt-1" }),
  );
  const result = await appendSupportCaseTurn(
    {
      caseId: "case",
      authorUserId: "impostor",
      sender: "AGENT",
      actorKind: "PRESENTER",
      body: "Reply",
      isInternal: false,
    },
    now,
  );
  expect(result).toMatchObject({ ok: false, status: 403, code: "FORBIDDEN" });
  expect(prisma.supportCaseMessage.create).not.toHaveBeenCalled();
});
it("refuses a presenter's private note", async () => {
  (cases.findUnique as jest.Mock).mockResolvedValueOnce(
    record({ appointmentId: "appt-1" }),
  );
  const result = await appendSupportCaseTurn(
    {
      caseId: "case",
      authorUserId: "presenter",
      sender: "AGENT",
      actorKind: "PRESENTER",
      body: "Private",
      isInternal: true,
    },
    now,
  );
  expect(result).toMatchObject({ ok: false, status: 403, code: "FORBIDDEN" });
  expect(prisma.supportCaseMessage.create).not.toHaveBeenCalled();
});
it("notifies accepted presenters on staff replies", async () => {
  mockPresenter();
  (cases.findUnique as jest.Mock).mockResolvedValueOnce(
    record({ appointmentId: "appt-1" }),
  );
  await appendSupportCaseTurn(
    {
      caseId: "case",
      authorUserId: "staff",
      sender: "AGENT",
      body: "Reply",
      isInternal: false,
    },
    now,
  );
  const recipients = (stageBell as jest.Mock).mock.calls[0][1].recipients;
  expect(recipients).toEqual(expect.arrayContaining(["customer", "presenter"]));
});

const mockRecipientEmails = () => {
  (prisma.user.findMany as jest.Mock).mockImplementation(
    async ({ where }: { where: { id: { in: string[] } } }) =>
      where.id.in.map((id) => ({ id, email: `${id}@example.com` })),
  );
};

const emailed = () =>
  (stageEmail as jest.Mock).mock.calls.map((call) => call[0].to);

describe("case turn notification routing", () => {
  it("bells the assignee on another staff member's reply but never emails them", async () => {
    mockPresenter();
    mockRecipientEmails();
    (cases.findUnique as jest.Mock).mockResolvedValueOnce(
      record({ appointmentId: "appt-1", assignedToId: "staff" }),
    );
    await appendSupportCaseTurn(
      {
        caseId: "case",
        authorUserId: "staff2",
        sender: "AGENT",
        body: "Reply",
        isInternal: false,
      },
      now,
    );
    const recipients = (stageBell as jest.Mock).mock.calls[0][1].recipients;
    expect(recipients).toEqual(
      expect.arrayContaining(["customer", "presenter", "staff"]),
    );
    expect(recipients).not.toContain("staff2");
    expect(emailed()).toEqual(
      expect.arrayContaining(["customer@example.com", "presenter@example.com"]),
    );
    expect(emailed()).not.toContain("staff@example.com");
    expect(emailed()).not.toContain("staff2@example.com");
  });

  it("emails correspondents, not the assignee, when a presenter replies", async () => {
    mockPresenter();
    mockRecipientEmails();
    (cases.findUnique as jest.Mock).mockResolvedValueOnce(
      record({ appointmentId: "appt-1", assignedToId: "staff" }),
    );
    await appendSupportCaseTurn(
      {
        caseId: "case",
        authorUserId: "presenter",
        sender: "AGENT",
        actorKind: "PRESENTER",
        body: "Reply",
        isInternal: false,
      },
      now,
    );
    const bell = stageBell as jest.Mock;
    expect(bell.mock.calls[0][1].recipients).toEqual(
      expect.arrayContaining(["customer", "staff"]),
    );
    expect(bell.mock.calls[0][1].recipients).not.toContain("presenter");
    expect(emailed()).toEqual(["customer@example.com"]);
    const [email] = (stageEmail as jest.Mock).mock.calls[0];
    expect(email.subject).toBe("New presenter reply — FAM-2026-000001");
    expect(email.text.split("\n").at(-1)).toBe(supportRequestHref("c_case"));
    expect(email.text).toContain("Reply");
  });

  it("bells the assignee but emails only presenters on a customer reply", async () => {
    mockPresenter();
    mockRecipientEmails();
    (cases.findUnique as jest.Mock).mockResolvedValueOnce(
      record({ appointmentId: "appt-1", assignedToId: "staff" }),
    );
    await appendSupportCaseTurn(
      {
        caseId: "case",
        authorUserId: "customer",
        sender: "USER",
        body: "Following up",
        isInternal: false,
      },
      now,
    );
    const recipients = (stageBell as jest.Mock).mock.calls[0][1].recipients;
    expect(recipients).toEqual(expect.arrayContaining(["staff", "presenter"]));
    expect(recipients).not.toContain("customer");
    expect(emailed()).toEqual(["presenter@example.com"]);
  });

  it("keeps presenters out of a sensitive case's notifications", async () => {
    mockPresenter();
    mockRecipientEmails();
    (cases.findUnique as jest.Mock).mockResolvedValueOnce(
      record({
        appointmentId: "appt-1",
        assignedToId: "staff",
        category: "SAFETY_CONCERN",
      }),
    );
    await appendSupportCaseTurn(
      {
        caseId: "case",
        authorUserId: "customer",
        sender: "USER",
        body: "Following up",
        isInternal: false,
      },
      now,
    );
    const recipients = (stageBell as jest.Mock).mock.calls[0][1].recipients;
    expect(recipients).toEqual(["staff"]);
    expect(emailed()).toEqual([]);
  });
});
it("never exposes internal notes or assignment details to the customer", async () => {
  (cases.findUnique as jest.Mock).mockResolvedValueOnce(
    record({
      assignedToId: "private-staff",
      messages: [
        { id: "public", isInternal: false },
        { id: "private", isInternal: true },
      ],
      events: [{ kind: "ASSIGNED", note: "private" }],
    }),
  );
  const result = await readSupportCaseForViewer("case", {
    userId: "customer",
    role: "CONSULTEE",
    isStaff: false,
  });
  expect(result?.messages).toEqual([{ id: "public", isInternal: false }]);
  expect(result).toHaveProperty("assignedToId", null);
  expect(result?.events).toEqual([]);
});
it("hides organization-owned correspondence after membership removal", async () => {
  (cases.findUnique as jest.Mock).mockResolvedValueOnce(
    record({
      ownershipScope: "ORG_BILLING",
      organizationId: "org",
      submitterUserId: "customer",
    }),
  );
  (prisma.membership.findUnique as jest.Mock).mockResolvedValueOnce({
    role: "OWNER",
    status: "REMOVED",
  });
  expect(
    await readSupportCaseForViewer("case", {
      userId: "customer",
      role: "ORG_WORKSPACE",
      isStaff: false,
    }),
  ).toBeNull();
});
it("does not reveal external complainants through a personal case read", async () => {
  (cases.findUnique as jest.Mock).mockResolvedValueOnce(
    record({ externalRequesterEmail: "private@example.test" }),
  );
  expect(
    await readSupportCaseForViewer("case", {
      userId: "customer",
      role: "CONSULTEE",
      isStaff: false,
    }),
  ).toBeNull();
});
it("gives a presenter the ordinary thread with the presenter marker and redactions", async () => {
  mockPresenter();
  (cases.findUnique as jest.Mock).mockResolvedValueOnce(
    record({
      appointmentId: "appt-1",
      callbackWindow: "09:00-12:00 IST",
      csatRating: 5,
      subjects: [
        {
          id: "s1",
          subjectType: "APPOINTMENT",
          subjectId: "appt-1",
          isPrimary: true,
        },
        {
          id: "s2",
          subjectType: "PAYMENT",
          subjectId: "pay-1",
          isPrimary: false,
        },
      ],
      messages: [
        {
          id: "m1",
          seq: 1,
          sender: "USER",
          body: "Hello",
          isInternal: false,
          metadata: null,
          createdAt: now,
        },
        {
          id: "m2",
          seq: 2,
          sender: "AGENT",
          body: "Presenter here",
          isInternal: false,
          metadata: { actorKind: "PRESENTER" },
          createdAt: now,
        },
      ],
    }),
  );
  const view = await readSupportCaseForViewer("case", {
    userId: "presenter",
    role: "CONSULTEE",
    isStaff: false,
  });
  expect(view).toMatchObject({
    viewerIsPresenter: true,
    callbackWindow: null,
    csatRating: null,
  });
  expect(view?.subjects.map((subject) => subject.subjectType)).toEqual([
    "APPOINTMENT",
  ]);
  expect(view?.messages).toEqual([
    expect.objectContaining({ id: "m1", actorKind: undefined }),
    expect.objectContaining({ id: "m2", actorKind: "PRESENTER" }),
  ]);
});
it("hides a sensitive presenter case from a direct read", async () => {
  mockPresenter();
  (cases.findUnique as jest.Mock).mockResolvedValueOnce(
    record({ appointmentId: "appt-1", category: "SAFETY_CONCERN" }),
  );
  expect(
    await readSupportCaseForViewer("case", {
      userId: "presenter",
      role: "CONSULTEE",
      isStaff: false,
    }),
  ).toBeNull();
});
it("rejects an expired CSAT without writing a rating", async () => {
  (cases.findUnique as jest.Mock).mockResolvedValueOnce(
    record({
      status: "RESOLVED",
      resolvedAt: new Date(now.getTime() - 29 * 86_400_000),
    }),
  );
  expect(
    await submitSupportCaseCsat(
      { caseId: "case", userId: "customer", rating: 5 },
      now,
    ),
  ).toMatchObject({ ok: false, status: 400 });
  expect(cases.updateMany).not.toHaveBeenCalled();
});
it("customer waiting time cannot postpone an urgent content deadline", () => {
  const deadline = supportDeadline("INTIMATE_CONTENT", now);
  expect(
    slaStateOf(
      {
        status: "IN_PROGRESS",
        ackDueAt: now,
        acknowledgedAt: now,
        resolutionDueAt: new Date(now.getTime() + 7 * 86_400_000),
        statutoryDueAt: deadline.statutoryDueAt,
        resolvedAt: null,
        awaitingUserSince: now,
        pausedSeconds: 0,
      },
      new Date(now.getTime() + 3 * 3_600_000),
    ),
  ).toMatchObject({ resolutionBreached: true });
});
it("monthly reporting uses category deadlines rather than subtracting waiting time", async () => {
  (cases.findMany as jest.Mock).mockResolvedValueOnce([
    record({
      acknowledgedAt: now,
      resolvedAt: new Date(now.getTime() + 3 * 3_600_000),
      statutoryDueAt: new Date(now.getTime() + 2 * 3_600_000),
    }),
  ]);
  expect(await supportMonthlyComplianceReport(2026, 10)).toMatchObject({
    received: 1,
    acknowledgedWithin24h: 1,
    resolvedWithinDeadline: 0,
  });
});

it("formal intake promotes an existing guided conversation into the human queue atomically", async () => {
  const guided = record({
    activeChannel: "SELF_SERVE",
    priority: "MEDIUM",
    messageSeq: 2,
  });
  (cases.findFirst as jest.Mock).mockResolvedValueOnce(guided);
  (cases.findUnique as jest.Mock).mockResolvedValueOnce(guided);
  (cases.findUniqueOrThrow as jest.Mock)
    .mockResolvedValueOnce({ messageSeq: 2 })
    .mockResolvedValueOnce(guided)
    .mockResolvedValueOnce({
      ...guided,
      activeChannel: "HUMAN",
      receivedAt: now,
    });
  await createOrReuseSupportCase(
    {
      title: "Help",
      description: "Please investigate",
      category: "GENERAL",
      requesterUserId: "customer",
      submitterUserId: "customer",
      activeChannel: "HUMAN",
    },
    now,
  );
  expect(cases.updateMany).toHaveBeenCalledWith(
    expect.objectContaining({
      data: expect.objectContaining({
        activeChannel: "HUMAN",
        receivedAt: now,
        status: "OPEN",
      }),
    }),
  );
  expect(cases.create).not.toHaveBeenCalled();
});

it("uses the canonical absolute case link in intake emails", async () => {
  (prisma.user.findMany as jest.Mock).mockResolvedValue([
    { id: "customer", email: "customer@example.com" },
  ]);
  await prisma.$transaction((tx) =>
    stageSupportCaseIntakeTx(
      tx,
      {
        id: "case",
        referenceNumber: "FAM-2026-000001",
        title: "Help",
        description: "Complaint",
        activeChannel: "HUMAN",
        submitterUserId: "customer",
        organizationId: null,
        ownershipScope: "PERSONAL",
        externalRequesterEmail: null,
        appointmentId: null,
        category: "GENERAL",
        issueType: null,
      },
      "USER",
    ),
  );
  const [email] = (stageEmail as jest.Mock).mock.calls[0];
  expect(email.text.split("\n").at(-1)).toBe(supportRequestHref("c_case"));
});

it("includes the recorded complaint in an organization case's intake email", async () => {
  (prisma.user.findMany as jest.Mock).mockResolvedValue([
    { id: "member", email: "member@example.com" },
  ]);
  await prisma.$transaction((tx) =>
    stageSupportCaseIntakeTx(
      tx,
      {
        id: "case",
        referenceNumber: "FAM-2026-000002",
        title: "Billing",
        description: "Our invoice total is wrong",
        activeChannel: "HUMAN",
        submitterUserId: "member",
        organizationId: "org-1",
        ownershipScope: "ORG_BILLING",
        externalRequesterEmail: null,
        appointmentId: null,
        category: "GENERAL",
        issueType: null,
      },
      "USER",
    ),
  );
  const [email] = (stageEmail as jest.Mock).mock.calls[0];
  expect(email.text).toContain("Our invoice total is wrong");
});
