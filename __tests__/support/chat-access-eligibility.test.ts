/** @jest-environment node */

jest.mock("../../lib/meetings/mirror-room-chat", () => ({
  __esModule: true,
  resolveCanonicalMeetingChannel: jest.fn(),
}));

import { OpsRefusal } from "../../lib/backoffice/ops-refusal-error";
import { resolveCanonicalMeetingChannel } from "../../lib/meetings/mirror-room-chat";
import {
  CHAT_DM_LEAD_IN_MS,
  caseChatRefusal,
  interventionBasisSource,
  readCaseChatStatus,
  requiresTargets,
  resolveCaseChat,
  scopeFor,
  verifiedInterventionBases,
  type CaseChat,
} from "../../lib/support/chat-access";

const resolveChannel = jest.mocked(resolveCanonicalMeetingChannel);
const CREATED = new Date("2026-10-01T10:00:00Z");

const openCase = {
  deletedAt: null,
  status: "IN_PROGRESS" as const,
  activeChannel: "HUMAN" as const,
  appointmentId: "appt-1",
};

function refusalCode(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (err) {
    if (err instanceof OpsRefusal) return err.code;
    throw err;
  }
}

describe("caseChatRefusal", () => {
  it("lets an open HUMAN case with a booking through", () => {
    expect(caseChatRefusal(openCase)).toBeNull();
  });

  it.each([
    ["RESOLVED", { status: "RESOLVED" as const }, "CASE_NOT_OPEN"],
    ["CLOSED", { status: "CLOSED" as const }, "CASE_NOT_OPEN"],
    ["deleted", { deletedAt: new Date() }, "CASE_NOT_FOUND"],
    ["self-serve", { activeChannel: "SELF_SERVE" as const }, "CASE_NOT_HUMAN"],
    ["AI", { activeChannel: "AI" as const }, "CASE_NOT_HUMAN"],
    ["no booking", { appointmentId: null }, "NO_BOOKING"],
  ])("refuses a %s case", (_label, patch, code) => {
    expect(caseChatRefusal({ ...openCase, ...patch })?.code).toBe(code);
  });

  it.each(["OPEN", "IN_PROGRESS", "ESCALATED"] as const)(
    "accepts status %s",
    (status) => {
      expect(caseChatRefusal({ ...openCase, status })).toBeNull();
    },
  );
});

function chatDb(appointment: Record<string, unknown> | null) {
  return {
    appointment: {
      findFirst: jest.fn(async () => appointment),
      findMany: jest.fn(async () =>
        appointment
          ? [
              {
                id: "appt-1",
                participants: [{ userId: "u-host" }],
                consultation: null,
                subscription: null,
                webinar: {
                  webinarPlan: {
                    consultantProfileId: "cp-host",
                    collaborators: [{ consultantProfileId: "cp-presenter" }],
                  },
                },
                class: null,
                payment: [{ hostOrganizationId: "org-host" }],
              },
            ]
          : [],
      ),
    },
    appointmentParticipant: {
      findMany: jest.fn(async () => [
        { userId: "u-learner" },
        { userId: "u-peer" },
        { userId: "u-host" },
      ]),
    },
    consultantProfile: {
      findMany: jest.fn(async () => [
        { id: "cp-host", user: { id: "u-host" } },
        { id: "cp-presenter", user: { id: "u-presenter" } },
      ]),
    },
  };
}

const webinarAppointment = {
  id: "appt-1",
  createdAt: CREATED,
  appointmentType: "WEBINAR",
  organizationId: "org-sponsor",
  consultation: null,
  subscription: null,
  webinar: { id: "web-1", webinarPlan: { organizationId: null } },
  class: null,
};

describe("resolveCaseChat", () => {
  beforeEach(() => resolveChannel.mockReset());

  it("resolves a group channel with delivering parties (crew excluded) and both tenants", async () => {
    resolveChannel.mockResolvedValue({
      channelType: "team",
      channelId: "webinar-web-1",
    });
    const chat = await resolveCaseChat(chatDb(webinarAppointment) as never, {
      appointmentId: "appt-1",
      requesterUserId: "u-learner",
    });
    expect(chat).toMatchObject({
      kind: "GROUP",
      channelId: "webinar-web-1",
      reporterId: "u-learner",
      dmPair: [],
    });
    expect(chat.deliveringIds.sort()).toEqual(["u-host", "u-presenter"]);
    expect(chat.attendeeIds.sort()).toEqual(["u-learner", "u-peer"]);
    expect(chat.organizationIds.sort()).toEqual(["org-host", "org-sponsor"]);
    expect(chat.windowStart.getTime()).toBe(
      CREATED.getTime() - CHAT_DM_LEAD_IN_MS,
    );
  });

  it("resolves a DM pair, with the window opening seven days before the booking", async () => {
    resolveChannel.mockResolvedValue({
      channelType: "messaging",
      channelId: "dm-a-b",
      consultantUserId: "u-host",
      consulteeUserId: "u-learner",
    });
    const chat = await resolveCaseChat(
      chatDb({
        ...webinarAppointment,
        appointmentType: "CONSULTATION",
      }) as never,
      { appointmentId: "appt-1", requesterUserId: "u-learner" },
    );
    expect(chat.kind).toBe("DM");
    expect(chat.dmPair).toEqual(["u-learner", "u-host"]);
    expect(chat.windowStart).toEqual(
      new Date(CREATED.getTime() - 7 * 24 * 3_600_000),
    );
  });

  it("refuses a trial booking without asking for a channel", async () => {
    await expect(
      resolveCaseChat(
        chatDb({ ...webinarAppointment, appointmentType: "TRIAL" }) as never,
        { appointmentId: "appt-1", requesterUserId: "u-learner" },
      ),
    ).rejects.toMatchObject({ code: "CHAT_DISABLED" });
    expect(resolveChannel).not.toHaveBeenCalled();
  });

  it("refuses a missing or deleted booking", async () => {
    await expect(
      resolveCaseChat(chatDb(null) as never, {
        appointmentId: "appt-1",
        requesterUserId: "u-learner",
      }),
    ).rejects.toMatchObject({ code: "NO_BOOKING" });
  });

  it("refuses a booking with no chat and a collaborator channel", async () => {
    resolveChannel.mockResolvedValueOnce(null);
    await expect(
      resolveCaseChat(chatDb(webinarAppointment) as never, {
        appointmentId: "appt-1",
        requesterUserId: "u-learner",
      }),
    ).rejects.toMatchObject({ code: "CHAT_NOT_FOUND" });
    resolveChannel.mockResolvedValueOnce({
      channelType: "team",
      channelId: "collab-x",
    });
    await expect(
      resolveCaseChat(chatDb(webinarAppointment) as never, {
        appointmentId: "appt-1",
        requesterUserId: "u-learner",
      }),
    ).rejects.toMatchObject({ code: "CHAT_NOT_FOUND" });
  });

  it("has no reporter when the requester is not in the booking", async () => {
    resolveChannel.mockResolvedValue({
      channelType: "team",
      channelId: "webinar-web-1",
    });
    const chat = await resolveCaseChat(chatDb(webinarAppointment) as never, {
      appointmentId: "appt-1",
      requesterUserId: "u-org-admin",
    });
    expect(chat.reporterId).toBeNull();
  });
});

function groupChat(patch: Partial<CaseChat> = {}): CaseChat {
  return {
    channelType: "team",
    channelId: "webinar-web-1",
    kind: "GROUP",
    appointmentId: "appt-1",
    windowStart: CREATED,
    organizationIds: [],
    dmPair: [],
    deliveringIds: ["u-host", "u-presenter"],
    attendeeIds: ["u-learner", "u-peer"],
    reporterId: "u-learner",
    ...patch,
  };
}

describe("scopeFor", () => {
  it("covers both members of a DM and nobody else", () => {
    const dm = groupChat({ kind: "DM", dmPair: ["u-learner", "u-host"] });
    expect(scopeFor(dm)).toEqual(["u-learner", "u-host"]);
    expect(refusalCode(() => scopeFor(dm, ["u-peer"]))).toBe(
      "TARGET_NOT_PARTY",
    );
  });

  it("an attendee reporter defaults to the delivering parties", () => {
    expect(scopeFor(groupChat()).sort()).toEqual([
      "u-host",
      "u-learner",
      "u-presenter",
    ]);
  });

  it("an attendee reporting a peer scopes to reporter and that peer only", () => {
    expect(scopeFor(groupChat(), ["u-peer"]).sort()).toEqual([
      "u-learner",
      "u-peer",
    ]);
  });

  it("a delivering reporter must pick attendee targets", () => {
    const chat = groupChat({ reporterId: "u-host" });
    expect(requiresTargets(chat)).toBe(true);
    expect(refusalCode(() => scopeFor(chat))).toBe("TARGETS_REQUIRED");
    expect(scopeFor(chat, ["u-peer"]).sort()).toEqual(["u-host", "u-peer"]);
  });

  it("an org-filed case with no party reporter needs at least one party", () => {
    const chat = groupChat({ reporterId: null });
    expect(refusalCode(() => scopeFor(chat))).toBe("TARGETS_REQUIRED");
    expect(scopeFor(chat, ["u-presenter"])).toEqual(["u-presenter"]);
  });

  it("refuses targets who are not live participants or delivering parties", () => {
    expect(refusalCode(() => scopeFor(groupChat(), ["u-stranger"]))).toBe(
      "TARGET_NOT_PARTY",
    );
  });
});

describe("intervention basis", () => {
  const evidence = (overdue: boolean) => ({
    supportCaseEvidenceRequest: {
      findFirst: jest.fn(async () => (overdue ? { id: "ev-1" } : null)),
    },
  });
  const now = new Date("2026-10-20T00:00:00Z");

  it("verifies overdue evidence with the sweep's predicate", async () => {
    const db = evidence(true);
    expect(
      await verifiedInterventionBases(
        db as never,
        { id: "case-1", category: "OTHER" },
        now,
      ),
    ).toEqual(["EVIDENCE_OVERDUE"]);
    expect(db.supportCaseEvidenceRequest.findFirst).toHaveBeenCalledWith({
      where: {
        caseId: "case-1",
        respondedAt: null,
        cancelledAt: null,
        dueAt: { lte: now },
      },
      select: { id: true },
    });
  });

  it("a SAFETY_CONCERN intake verifies safety and fraud", async () => {
    expect(
      await verifiedInterventionBases(
        evidence(false) as never,
        { id: "case-1", category: "SAFETY_CONCERN" },
        now,
      ),
    ).toEqual(["SAFETY", "FRAUD_OR_SCAM"]);
  });

  it("staff may assert safety or fraud but never overdue evidence", () => {
    expect(interventionBasisSource("SAFETY", [])).toBe("ASSERTED");
    expect(interventionBasisSource("FRAUD_OR_SCAM", [])).toBe("ASSERTED");
    expect(interventionBasisSource("SAFETY", ["SAFETY"])).toBe("VERIFIED");
    expect(
      refusalCode(() => interventionBasisSource("EVIDENCE_OVERDUE", [])),
    ).toBe("BASIS_NOT_MET");
  });
});

describe("readCaseChatStatus", () => {
  it("reports the refusal for an ineligible case and lists its grants", async () => {
    const now = new Date();
    const db = {
      supportCase: {
        findUnique: jest.fn(async () => ({
          id: "case-1",
          category: "OTHER",
          requesterUserId: "u-learner",
          ...openCase,
          activeChannel: "SELF_SERVE",
        })),
      },
      supportCaseChatAccess: { findMany: jest.fn(async () => []) },
    };
    const status = await readCaseChatStatus(db as never, {
      caseId: "case-1",
      actorId: "u-staff",
      canIntervene: true,
      now,
    });
    expect(status).toMatchObject({
      channel: null,
      read: { ok: false, code: "CASE_NOT_HUMAN" },
      intervene: { ok: false, code: "CASE_NOT_HUMAN" },
      grants: [],
    });
  });
});
