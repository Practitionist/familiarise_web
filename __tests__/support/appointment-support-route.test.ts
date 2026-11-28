/**
 * @jest-environment node
 */

/**
 * #support-hub — per-appointment support thread ROUTE wiring.
 *
 * The regression that started this: seeded demo databases mint readable slug
 * ids (`demo0813-appt-ba`), and the old `z.string().uuid()` param gate 400'd
 * them with "Invalid appointment id" before the DB lookup could speak — the
 * toast every consultant on the preview deploy saw. These pin the opaque-id
 * contract and the coded envelope at the route boundary.
 */

jest.mock("@sentry/nextjs", () => ({
  __esModule: true,
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

// The REAL appointmentAuthzError must run (its mapping is what the route
// ships), so appointment-access is only half-mocked below — which means its
// own imports need mocks too, or requireActual drags in better-auth's ESM.
jest.mock("../../lib/auth-server", () => ({
  __esModule: true,
  getSession: jest.fn(),
}));
jest.mock("../../lib/auth-helpers", () => ({
  __esModule: true,
  isPrivileged: jest.fn(),
  requireApiAuth: jest.fn(async () => ({ session: { user: { id: "u1" } } })),
}));
jest.mock("../../lib/auth/org-permissions", () => ({
  __esModule: true,
  hasOrgPermission: jest.fn(),
}));
jest.mock("../../lib/data/appointment-detail", () => ({
  __esModule: true,
  readAppointmentDetail: jest.fn(),
  canAccessAppointment: jest.fn(),
}));

jest.mock("../../lib/api/appointment-access", () => ({
  __esModule: true,
  ...jest.requireActual("../../lib/api/appointment-access"),
  authorizeAppointment: jest.fn(),
}));

jest.mock("../../lib/prisma", () => {
  const { memTable } = jest.requireActual("../fixtures/mem-db");
  return {
    __esModule: true,
    default: {
      supportCase: {
        findFirst: jest.fn(),
        findUnique: jest.fn(),
        findMany: jest.fn(async () => []),
      },
      appointmentOccurrence: memTable([], "occ"),
      // The thread readers apply the case read policy, which reads the viewer's memberships; none here.
      membership: { findMany: jest.fn(async () => []) },
    },
  };
});

jest.mock("../../lib/support/service", () => ({
  __esModule: true,
  runSupportTurn: jest.fn(),
}));

jest.mock("../../lib/rate-limit", () => ({
  __esModule: true,
  spamLimiter: { id: "spamLimiter" },
  supportTurnLimiter: { id: "supportTurnLimiter" },
  applyRateLimit: jest.fn(async () => null),
}));

jest.mock("../../lib/support/context", () => ({
  __esModule: true,
  buildSupportContext: jest.fn(),
}));

import { NextRequest } from "next/server";
import { authorizeAppointment } from "../../lib/api/appointment-access";
import { applyRateLimit } from "../../lib/rate-limit";
import prisma from "../../lib/prisma";
import { buildSupportContext } from "../../lib/support/context";
import { runSupportTurn } from "../../lib/support/service";
import {
  bindTurn,
  supportTurnBody,
  type TurnVars,
} from "../../components/support/useSupportThread";
import { SupportTurnSchema } from "../../schemas/support";
import type { memTable } from "../fixtures/mem-db";
import {
  GET,
  POST,
} from "../../app/api/appointments/[appointmentId]/support/route";

const mockedAuthorize = authorizeAppointment as jest.Mock;
const mockedFindThread = prisma.supportCase.findFirst as jest.Mock;
const mockedBuildContext = buildSupportContext as jest.Mock;
const mockedRunTurn = runSupportTurn as jest.Mock;

const SLUG = "demo0813-appt-ba";

function req(method: string, body?: unknown): NextRequest {
  return new NextRequest(`https://x.test/api/appointments/${SLUG}/support`, {
    method,
    ...(body !== undefined
      ? {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      : {}),
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
  mockedFindThread.mockResolvedValue(null);
  mockedBuildContext.mockResolvedValue(null);
});

describe("GET /api/appointments/[appointmentId]/support", () => {
  it("REGRESSION: accepts seeded slug ids the old .uuid() gate rejected", async () => {
    const res = await GET(req("GET"), {
      params: Promise.resolve({ appointmentId: SLUG }),
    });
    expect(res.status).toBe(200);
    expect(mockedAuthorize).toHaveBeenCalledWith(SLUG, true);
    const json = await res.json();
    expect(json.data).toBeNull();
    expect(json.intents).toEqual([]);
  });

  it("returns the session the thread is about, which the client names on its next turn", async () => {
    mockedFindThread.mockResolvedValue({
      id: "case-1",
      requesterUserId: "u1",
      activeChannel: "SELF_SERVE",
      appointmentOccurrenceId: "occ-1",
      messages: [],
    });
    const res = await GET(req("GET"), {
      params: Promise.resolve({ appointmentId: SLUG }),
    });
    expect(mockedFindThread.mock.calls[0][0].select).toMatchObject({
      appointmentOccurrenceId: true,
    });
    expect((await res.json()).data.appointmentOccurrenceId).toBe("occ-1");
  });

  it("shows the booking-wide thread by default, and a session's case only when the page names it", async () => {
    const { matchesWhere } = jest.requireActual("../fixtures/mem-db");
    const own = {
      appointmentId: SLUG,
      requesterUserId: "u1",
      submitterUserId: "u1",
      deletedAt: null,
      // A person's own case, as the read policy sees every real row.
      ownershipScope: "PERSONAL",
      externalRequesterEmail: null,
      activeChannel: "SELF_SERVE",
      messages: [],
    };
    const rows = [
      {
        ...own,
        id: "case-pay",
        appointmentOccurrenceId: null,
        createdAt: new Date("2026-11-20T10:00:00Z"),
      },
      {
        ...own,
        id: "case-report",
        category: "NO_SHOW",
        appointmentOccurrenceId: "occ-a",
        createdAt: new Date("2026-11-23T12:00:00Z"),
      },
      {
        ...own,
        id: "case-foreign",
        requesterUserId: "u2",
        submitterUserId: "u2",
        appointmentOccurrenceId: null,
        createdAt: new Date("2026-11-24T12:00:00Z"),
      },
    ];
    mockedFindThread.mockImplementation(
      async (args: { where: Record<string, unknown> }) =>
        rows
          .filter((r) => matchesWhere(r, args.where))
          .sort((a, b) => Number(b.createdAt) - Number(a.createdAt))[0] ?? null,
    );
    const shown = async (query = "") => {
      const res = await GET(
        new NextRequest(
          `https://x.test/api/appointments/${SLUG}/support${query}`,
        ),
        { params: Promise.resolve({ appointmentId: SLUG }) },
      );
      return (await res.json()).data?.id;
    };
    expect(await shown()).toBe("case-pay");
    expect(await shown("?occurrence=occ-a")).toBe("case-report");
    // A session's page never falls back to another thread: it starts that session's report.
    expect(await shown("?occurrence=occ-b")).toBeUndefined();
    // It keeps the caller's own booking-wide case when the page names it, as a page moved there does.
    expect(await shown("?occurrence=occ-b&caseId=case-pay")).toBe("case-pay");
    // Another session's case, or another person's booking-wide case, is not shown there by name.
    expect(await shown("?occurrence=occ-b&caseId=case-report")).toBeUndefined();
    expect(
      await shown("?occurrence=occ-b&caseId=case-foreign"),
    ).toBeUndefined();
    expect(await shown("?caseId=case-report")).toBe("case-report");
    // Another person's case is never shown; the default stands.
    expect(await shown("?caseId=case-foreign")).toBe("case-pay");
    rows.splice(0, 1);
    // With no booking-wide thread the booking's page starts fresh, and links the open report instead.
    (prisma.supportCase.findMany as jest.Mock).mockImplementation(
      async (args: { where: Record<string, unknown> }) =>
        rows
          .filter((r) =>
            matchesWhere(
              { ...r, category: "NO_SHOW", status: "OPEN" },
              args.where,
            ),
          )
          .map((r) => ({
            id: r.id,
            appointmentOccurrenceId: r.appointmentOccurrenceId,
            occurrence: { startsAt: new Date("2026-11-14T11:30:00Z") },
          })),
    );
    const res = await GET(
      new NextRequest(`https://x.test/api/appointments/${SLUG}/support`),
      { params: Promise.resolve({ appointmentId: SLUG }) },
    );
    const body = await res.json();
    expect(body.data).toBeNull();
    expect(body.sessionReports).toEqual([
      {
        caseId: "case-report",
        occurrenceId: "occ-a",
        startsAt: "2026-11-14T11:30:00.000Z",
      },
    ]);
    expect(await shown("?occurrence=occ-a")).toBe("case-report");
  });

  it("offers the report from the session the page names, and lists the ended sessions", async () => {
    const endedA = {
      id: "occ-a",
      startsAt: new Date("2026-11-23T10:00:00Z"),
      endsAt: new Date("2026-11-23T11:00:00Z"),
    };
    mockedBuildContext.mockResolvedValue({
      planTitle: "Plan",
      appointmentType: "SUBSCRIPTION",
      startsAt: new Date("2026-11-30T10:00:00Z"),
      organizationId: null,
      stage: "UPCOMING",
      isProvider: false,
      reportSessions: [endedA],
      reportOccurrenceId: "occ-a",
    });
    const res = await GET(
      new NextRequest(
        `https://x.test/api/appointments/${SLUG}/support?occurrence=occ-a`,
      ),
      { params: Promise.resolve({ appointmentId: SLUG }) },
    );
    expect(mockedBuildContext).toHaveBeenCalledWith(
      expect.any(String),
      SLUG,
      "u1",
      undefined,
      "occ-a",
    );
    const body = await res.json();
    expect(body.intents.map((i: { category: string }) => i.category)).toEqual(
      expect.arrayContaining(["NO_SHOW", "RESCHEDULE"]),
    );
    expect(body.reportSessions).toEqual([
      {
        id: "occ-a",
        startsAt: "2026-11-23T10:00:00.000Z",
        endsAt: "2026-11-23T11:00:00.000Z",
      },
    ]);
  });

  it("accepts uuid ids identically", async () => {
    const uuid = "329c0b89-0648-4f8e-82a4-25811cdea440";
    const res = await GET(req("GET"), {
      params: Promise.resolve({ appointmentId: uuid }),
    });
    expect(res.status).toBe(200);
    expect(mockedAuthorize).toHaveBeenCalledWith(uuid, true);
  });

  it("400 INVALID_ID envelope on an over-long id — garbage never reaches Prisma", async () => {
    const long = "x".repeat(65);
    const res = await GET(req("GET"), {
      params: Promise.resolve({ appointmentId: long }),
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.code).toBe("INVALID_ID");
    expect(json.detail).toBeDefined();
    expect(mockedAuthorize).not.toHaveBeenCalled();
    expect(mockedFindThread).not.toHaveBeenCalled();
  });

  it("maps a coded FORBIDDEN through the envelope", async () => {
    mockedAuthorize.mockResolvedValue({ code: "FORBIDDEN", status: 403 });
    const res = await GET(req("GET"), {
      params: Promise.resolve({ appointmentId: SLUG }),
    });
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.code).toBe("FORBIDDEN");
    expect(typeof json.error).toBe("string");
  });
});

describe("POST /api/appointments/[appointmentId]/support", () => {
  it("advances a turn for a slug id and returns the result", async () => {
    mockedRunTurn.mockResolvedValue({
      messages: [{ sender: "BOT", body: "Pick an option" }],
      nextNodeId: "n2",
      actions: [],
    });
    const res = await POST(req("POST", { category: "CANCEL_REFUND" }), {
      params: Promise.resolve({ appointmentId: SLUG }),
    });
    expect(res.status).toBe(200);
    expect(mockedRunTurn).toHaveBeenCalledWith(
      SLUG,
      "u1",
      expect.objectContaining({ category: "CANCEL_REFUND", isOrgParty: false }),
    );
  });

  it("meters turns on the generous per-user turn budget, never the 5/h spam bucket (SFR-02-04)", async () => {
    mockedRunTurn.mockResolvedValue({
      messages: [],
      nextNodeId: null,
      actions: [],
    });
    for (let i = 0; i < 6; i++) {
      const res = await POST(req("POST", { userMessage: `turn ${i}` }), {
        params: Promise.resolve({ appointmentId: SLUG }),
      });
      expect(res.status).toBe(200);
    }
    expect(mockedRunTurn).toHaveBeenCalledTimes(6);
    expect(applyRateLimit).toHaveBeenCalledTimes(6);
    for (const [limiter, key] of (applyRateLimit as jest.Mock).mock.calls) {
      expect(limiter).toEqual({ id: "supportTurnLimiter" });
      expect(key).toBe("appt-turn:u1");
    }
  });

  it("answers the limiter's 429 without running the turn", async () => {
    (applyRateLimit as jest.Mock).mockResolvedValueOnce(
      new Response(null, { status: 429 }),
    );
    const res = await POST(req("POST", { userMessage: "again" }), {
      params: Promise.resolve({ appointmentId: SLUG }),
    });
    expect(res.status).toBe(429);
    expect(mockedRunTurn).not.toHaveBeenCalled();
  });

  it("reaches a human across typed turns and the human chip within the turn budget (SFR-02-04)", async () => {
    mockedRunTurn.mockResolvedValue({
      messages: [{ sender: "BOT", body: "How can I help?" }],
      nextNodeId: "n2",
      actions: [],
    });
    const payloads = [
      { userMessage: "I could not join the call" },
      { userMessage: "The host never showed up" },
      { userMessage: "Please help resolve this" },
      { chosenOptionId: "human" },
    ];
    for (const payload of payloads) {
      const res = await POST(req("POST", payload), {
        params: Promise.resolve({ appointmentId: SLUG }),
      });
      expect(res.status).toBe(200);
    }
    expect(mockedRunTurn).toHaveBeenCalledTimes(payloads.length);
    expect(applyRateLimit).not.toHaveBeenCalledWith(
      { id: "spamLimiter" },
      expect.anything(),
    );
  });

  it("passes the customer's urgent flag through to the hand-off", async () => {
    mockedRunTurn.mockResolvedValue({ messages: [], actions: [] });
    await POST(
      req("POST", {
        category: "OTHER",
        userMessage: "the audio kept cutting out",
        urgent: true,
      }),
      { params: Promise.resolve({ appointmentId: SLUG }) },
    );
    expect(mockedRunTurn).toHaveBeenCalledWith(
      SLUG,
      "u1",
      expect.objectContaining({ category: "OTHER", urgent: true }),
    );
  });

  it("forwards the case a follow-up names to the turn, which checks it is the caller's own", async () => {
    mockedRunTurn.mockResolvedValue({ messages: [], actions: [] });
    await POST(req("POST", { chosenOptionId: "expert", caseId: "case-a" }), {
      params: Promise.resolve({ appointmentId: SLUG }),
    });
    expect(mockedRunTurn).toHaveBeenCalledWith(
      SLUG,
      "u1",
      expect.objectContaining({ chosenOptionId: "expert", caseId: "case-a" }),
    );
  });

  it("VALIDATION_FAILED envelope when the turn has nothing actionable", async () => {
    const res = await POST(req("POST", {}), {
      params: Promise.resolve({ appointmentId: SLUG }),
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.code).toBe("VALIDATION_FAILED");
    expect(mockedRunTurn).not.toHaveBeenCalled();
  });

  describe("the session a report is about", () => {
    const occurrences = prisma.appointmentOccurrence as unknown as ReturnType<
      typeof memTable
    >;
    const hourFromNow = (h: number) => new Date(Date.now() + h * 3_600_000);
    beforeEach(() => {
      occurrences.rows.splice(0, occurrences.rows.length);
      occurrences.rows.push(
        ...[
          ["occ-ended", SLUG, hourFromNow(-2)],
          ["occ-foreign", "other-appt", hourFromNow(-2)],
          ["occ-future", SLUG, hourFromNow(2)],
        ].map(([id, appointmentId, endsAt]) => ({
          id,
          appointmentId,
          endsAt,
          deletedAt: null,
          completionStatus: "COMPLETED",
        })),
      );
      mockedRunTurn.mockResolvedValue({ messages: [], actions: [] });
    });

    it("every turn the thread sends names what it answers and parses through the route's schema", () => {
      const threadA = {
        id: "case-a",
        activeChannel: "SELF_SERVE",
        appointmentOccurrenceId: "occ-ended",
      };
      const sent = (vars: TurnVars, page?: string) =>
        SupportTurnSchema.parse(
          supportTurnBody({ ...vars, binding: bindTurn(vars, threadA, page) }),
        );
      // A new intent names only the page's session, never the shown thread's.
      expect(
        sent({ category: "NO_SHOW", clientTurnId: "t-1" }, "occ-other"),
      ).toEqual({
        category: "NO_SHOW",
        clientTurnId: "t-1",
        appointmentOccurrenceId: "occ-other",
      });
      expect(sent({ category: "NO_SHOW", chosenLabel: "No-show" })).toEqual({
        category: "NO_SHOW",
      });
      // An answer names the case and session it answers, whatever the page says.
      expect(
        sent(
          { chosenOptionId: "expert", chosenLabel: "The expert" },
          "occ-other",
        ),
      ).toEqual({
        chosenOptionId: "expert",
        caseId: "case-a",
        appointmentOccurrenceId: "occ-ended",
      });
      // A thread not yet stored names nothing.
      expect(
        supportTurnBody({
          userMessage: "Hello",
          binding: bindTurn(
            { userMessage: "Hello" },
            { ...threadA, id: "local" },
            undefined,
          ),
        }),
      ).toEqual({ userMessage: "Hello" });
    });

    it("passes an ended session of this booking through to the turn", async () => {
      const res = await POST(
        req("POST", {
          category: "NO_SHOW",
          appointmentOccurrenceId: "occ-ended",
        }),
        { params: Promise.resolve({ appointmentId: SLUG }) },
      );
      expect(res.status).toBe(200);
      expect(mockedRunTurn).toHaveBeenCalledWith(
        SLUG,
        "u1",
        expect.objectContaining({ appointmentOccurrenceId: "occ-ended" }),
      );
    });

    it.each(["occ-foreign", "occ-future", "occ-missing"])(
      "refuses %s with 400 without running the turn",
      async (appointmentOccurrenceId) => {
        const res = await POST(
          req("POST", { category: "NO_SHOW", appointmentOccurrenceId }),
          { params: Promise.resolve({ appointmentId: SLUG }) },
        );
        expect(res.status).toBe(400);
        expect((await res.json()).code).toBe("VALIDATION_FAILED");
        expect(mockedRunTurn).not.toHaveBeenCalled();
      },
    );

    it("lets a reply on an upcoming session's case through, leaving the case check to the turn", async () => {
      const res = await POST(
        req("POST", {
          userMessage: "Can we move it to Friday?",
          caseId: "case-upcoming",
          appointmentOccurrenceId: "occ-future",
        }),
        { params: Promise.resolve({ appointmentId: SLUG }) },
      );
      expect(res.status).toBe(200);
      expect(mockedRunTurn).toHaveBeenCalledWith(
        SLUG,
        "u1",
        expect.objectContaining({
          caseId: "case-upcoming",
          appointmentOccurrenceId: "occ-future",
        }),
      );
    });

    it("lets a reply naming only an upcoming session of this booking through", async () => {
      const res = await POST(
        req("POST", {
          userMessage: "Is it still on?",
          appointmentOccurrenceId: "occ-future",
        }),
        { params: Promise.resolve({ appointmentId: SLUG }) },
      );
      expect(res.status).toBe(200);
    });

    it("still refuses a reply naming no case on another booking's session", async () => {
      const res = await POST(
        req("POST", {
          userMessage: "Hello",
          appointmentOccurrenceId: "occ-foreign",
        }),
        { params: Promise.resolve({ appointmentId: SLUG }) },
      );
      expect(res.status).toBe(400);
      expect(mockedRunTurn).not.toHaveBeenCalled();
    });
  });

  it("NOT_FOUND envelope when the resolver cannot find the appointment", async () => {
    mockedRunTurn.mockResolvedValue(null);
    const res = await POST(req("POST", { userMessage: "hello?" }), {
      params: Promise.resolve({ appointmentId: SLUG }),
    });
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.code).toBe("NOT_FOUND");
  });
});

it("restores guided choices on GET while keeping presenter attribution separate", async () => {
  const options = [{ id: "human", label: "Talk to a person", escalates: true }];
  mockedFindThread.mockResolvedValue({
    id: "case-1",
    activeChannel: "SELF_SERVE",
    currentNodeId: "prompt-1",
    requesterUserId: "u1",
    messages: [
      {
        id: "bot-1",
        seq: 1,
        sender: "BOT",
        body: "Pick an option",
        metadata: { nodeId: "prompt-1", options, privateField: "hidden" },
      },
      {
        id: "presenter-1",
        seq: 2,
        sender: "AGENT",
        body: "Presenter here",
        metadata: { actorKind: "PRESENTER", privateField: "hidden" },
      },
    ],
  });
  const res = await GET(req("GET"), {
    params: Promise.resolve({ appointmentId: SLUG }),
  });
  const json = await res.json();
  expect(json.data.messages[0].metadata).toEqual({
    nodeId: "prompt-1",
    options,
  });
  expect(json.data.messages[1].actorKind).toBe("PRESENTER");
  expect(json.data.messages[1].metadata).not.toHaveProperty("privateField");
});
