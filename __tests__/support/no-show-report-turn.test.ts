/** @jest-environment node */

// Invariant: a NO_SHOW turn files on its session's own case (scope
// OCCURRENCE:<id>), never on another open thread of the booking, and its
// terminal's reason is stored once, by CAS from null, with the terminal turn.

jest.mock("../../lib/prisma", () => {
  const { memTable } = jest.requireActual("../fixtures/mem-db");
  const supportCase = memTable([], "case");
  const db = {
    appointment: { findUnique: jest.fn() },
    supportCase: {
      ...supportCase,
      findUniqueOrThrow: jest.fn(async (args: unknown) => {
        const hit = await supportCase.findUnique(args);
        if (!hit) throw new Error("No SupportCase found");
        return hit;
      }),
    },
    supportCaseMessage: memTable([], "msg"),
    supportCaseEvent: memTable([], "evt"),
    $transaction: jest.fn(),
  };
  db.$transaction.mockImplementation((fn: (tx: typeof db) => unknown) =>
    fn(db),
  );
  return {
    __esModule: true,
    default: db,
    ALLOCATION_TX_MAX_WAIT_MS: 1000,
    ALLOCATION_TX_TIMEOUT_MS: 1000,
  };
});
jest.mock("../../lib/booking/participants", () => ({
  seatOrganizationId: jest.fn(async () => null),
}));
jest.mock("../../lib/support/context", () => ({
  buildSupportContext: jest.fn(),
}));
jest.mock("../../lib/support/case-service", () => ({
  createOrReuseSupportCase: jest.fn(),
  stageSupportCaseIntakeTx: jest.fn(async () => undefined),
  latestCaseDecisionTx: jest.fn(async () => null),
  appendSupportCaseTurn: jest.fn(async () => ({ ok: true })),
}));
jest.mock("../../lib/support/deflection", () => ({
  recordFlowOutcome: jest.fn(async () => "outcome"),
}));

import prisma from "../../lib/prisma";
import { buildSupportContext } from "../../lib/support/context";
import { createOrReuseSupportCase } from "../../lib/support/case-service";
import { runSupportTurn } from "../../lib/support/service";
import type { SupportContext } from "../../lib/support/types";
import {
  matchesWhere,
  type memTable,
  type Row,
  type Where,
} from "../fixtures/mem-db";

type Table = ReturnType<typeof memTable>;
const db = prisma as unknown as {
  appointment: { findUnique: jest.Mock };
  supportCase: Table;
  supportCaseMessage: Table;
};
const cases = db.supportCase;

const ENDED = new Date("2026-11-23T11:00:00Z");
let clock = 0;
const nextAt = () => new Date(Date.UTC(2026, 10, 24, 9, 0, clock++));

function openCase(overrides: Row): Row {
  return {
    requesterUserId: "learner",
    submitterUserId: "learner",
    organizationId: null,
    appointmentId: "appointment",
    appointmentOccurrenceId: null,
    ownershipScope: "PERSONAL",
    scopeKey: "APPOINTMENT:appointment",
    status: "OPEN",
    activeChannel: "SELF_SERVE",
    currentNodeId: null,
    flowReason: null,
    flowReasonAt: null,
    priority: "MEDIUM",
    closedAt: null,
    deletedAt: null,
    resolvedAt: null,
    assignedToId: null,
    awaitingUserSince: null,
    messageSeq: 1,
    createdAt: nextAt(),
    updatedAt: nextAt(),
    ...overrides,
  };
}

/** Postgres's open-scope reuse: one open case per scope, category and requester. */
function emulateIntake() {
  jest.mocked(createOrReuseSupportCase).mockImplementation(async (input) => {
    const scopeKey = input.appointmentOccurrenceId
      ? `OCCURRENCE:${input.appointmentOccurrenceId}`
      : `APPOINTMENT:${input.appointmentId}`;
    const open = cases.rows.find(
      (r) =>
        r.scopeKey === scopeKey &&
        r.category === input.category &&
        r.requesterUserId === input.requesterUserId &&
        r.closedAt === null,
    );
    const row =
      open ??
      openCase({
        id: `case-${cases.rows.length + 1}`,
        requesterUserId: input.requesterUserId,
        submitterUserId: input.submitterUserId,
        category: input.category,
        scopeKey,
        appointmentOccurrenceId: input.appointmentOccurrenceId ?? null,
      });
    if (!open) cases.rows.push(row);
    return { supportCase: row, reused: !!open, dedupeReason: null } as never;
  });
}

function context(isProvider: boolean): SupportContext {
  return {
    threadId: "pending",
    appointmentId: "appointment",
    userId: isProvider ? "host" : "learner",
    organizationId: null,
    appointmentType: "CONSULTATION",
    isOrgContext: false,
    isProvider,
    isOrgOperator: false,
    stage: "COMPLETED",
    startsAt: new Date(ENDED.getTime() - 3_600_000),
    endsAt: ENDED,
    lastEndedOccurrenceId: "occ-ended",
    refundPctIfCancelledNow: null,
    paymentId: null,
    paymentAmountPaise: null,
    hasRecording: false,
    planTitle: "Career chat",
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  for (const t of [cases, db.supportCaseMessage]) t.rows.splice(0);
  db.appointment.findUnique.mockResolvedValue({
    id: "appointment",
    appointmentType: "CONSULTATION",
    organizationId: null,
  });
  // The in-memory table ignores orderBy; the thread read wants the newest open case.
  cases.findFirst.mockImplementation(async (args: { where?: Where } = {}) => {
    const newest = cases.rows
      .filter((r) => matchesWhere(r, args.where))
      .sort((a, b) => Number(b.createdAt) - Number(a.createdAt))[0];
    return newest ? { ...newest } : null;
  });
  emulateIntake();
});

it("opens the session's own case while another booking thread is open, and the follow-up lands on it", async () => {
  const other = openCase({ id: "case-other", category: "PAYMENT_STATUS" });
  cases.rows.push(other);
  jest.mocked(buildSupportContext).mockResolvedValue(context(false));

  const first = await runSupportTurn("appointment", "learner", {
    category: "NO_SHOW",
  });
  expect(first?.appointmentOccurrenceId).toBe("occ-ended");
  expect(createOrReuseSupportCase).toHaveBeenCalledWith(
    expect.objectContaining({
      category: "NO_SHOW",
      appointmentOccurrenceId: "occ-ended",
    }),
  );
  const noShow = cases.rows.find((r) => r.category === "NO_SHOW")!;
  expect(noShow).toMatchObject({ scopeKey: "OCCURRENCE:occ-ended" });
  expect(other).toMatchObject({ category: "PAYMENT_STATUS", flowReason: null });

  // The client names the session the first turn answered on.
  const result = await runSupportTurn("appointment", "learner", {
    chosenOptionId: "expert",
    appointmentOccurrenceId: "occ-ended",
  });
  expect(result).toMatchObject({ threadId: noShow.id, escalated: true });
  expect(noShow.flowReason).toBe("provider_no_show");
  expect(noShow.flowReasonAt).toBeInstanceOf(Date);
});

it("an answer lands on the case of the session it names, and a turn naming none touches neither", async () => {
  const session = (id: string) =>
    openCase({
      id: `case-${id}`,
      category: "NO_SHOW",
      scopeKey: `OCCURRENCE:${id}`,
      appointmentOccurrenceId: id,
      currentNodeId: "start",
    });
  // B is the newer case, so a newest-open-case lookup would pick it.
  const [a, b] = [session("occ-a"), session("occ-b")];
  cases.rows.push(a, b);
  jest.mocked(buildSupportContext).mockResolvedValue(context(false));
  const on = (c: Row) =>
    db.supportCaseMessage.rows.filter((m) => m.caseId === c.id).length;

  const answered = await runSupportTurn("appointment", "learner", {
    chosenOptionId: "expert",
    appointmentOccurrenceId: "occ-a",
  });
  expect(answered?.threadId).toBe(a.id);
  expect(a.flowReason).toBe("provider_no_show");
  expect(b).toMatchObject({ flowReason: null, currentNodeId: "start" });
  expect(on(b)).toBe(0);

  const sentA = on(a);
  const loose = await runSupportTurn("appointment", "learner", {
    userMessage: "Is anyone there?",
  });
  expect([a.id, b.id]).not.toContain(loose?.threadId);
  expect([on(a), on(b)]).toEqual([sentA, 0]);
  expect(b).toMatchObject({ flowReason: null, currentNodeId: "start" });
});

it("files on the session the turn names over the default one", async () => {
  jest.mocked(buildSupportContext).mockResolvedValue(context(false));
  await runSupportTurn("appointment", "learner", {
    category: "NO_SHOW",
    appointmentOccurrenceId: "occ-earlier",
  });
  expect(cases.rows[0]).toMatchObject({ scopeKey: "OCCURRENCE:occ-earlier" });
});

it("lets a later 'I was there' replace a neutral first answer, but never turns a counted reason around", async () => {
  jest.mocked(buildSupportContext).mockResolvedValue(context(true));
  await runSupportTurn("appointment", "host", { category: "NO_SHOW" });
  const occ = { appointmentOccurrenceId: "occ-ended" };
  await runSupportTurn("appointment", "host", {
    chosenOptionId: "client",
    ...occ,
  });
  const noShow = cases.rows[0];
  expect(noShow).toMatchObject({
    status: "RESOLVED",
    flowReason: "attendee_no_show",
  });

  // The neutral first answer gives way, so the dispute reaches the window-close pass.
  await runSupportTurn("appointment", "host", { category: "NO_SHOW" });
  await runSupportTurn("appointment", "host", {
    chosenOptionId: "attended",
    ...occ,
  });
  expect(cases.rows).toHaveLength(1);
  expect(noShow).toMatchObject({
    activeChannel: "HUMAN",
    flowReason: "provider_attended",
  });

  // The case is with a person now: a later guided choice is refused, and the counted reason stands.
  const answeredAt = noShow.flowReasonAt;
  await runSupportTurn("appointment", "host", { category: "NO_SHOW" });
  await expect(
    runSupportTurn("appointment", "host", {
      chosenOptionId: "client",
      caseId: String(noShow.id),
      ...occ,
    }),
  ).rejects.toMatchObject({ body: { code: "OPTION_NOT_AVAILABLE" } });
  expect(noShow).toMatchObject({
    flowReason: "provider_attended",
    flowReasonAt: answeredAt,
  });
});

it("stores no reason for a terminal outside the no-show intent", async () => {
  cases.rows.push(openCase({ id: "case-q", category: "QUALITY_COMPLAINT" }));
  jest.mocked(buildSupportContext).mockResolvedValue(context(false));
  await runSupportTurn("appointment", "learner", {
    category: "QUALITY_COMPLAINT",
  });
  await runSupportTurn("appointment", "learner", {
    chosenOptionId: "poor",
  });
  expect(cases.rows[0].flowReason).toBeNull();
});

it("never opens a session report for an org operator, whose thread stays on the org-party intents", async () => {
  jest.mocked(buildSupportContext).mockResolvedValue(context(false));
  await runSupportTurn("appointment", "learner", {
    category: "NO_SHOW",
    isOrgParty: true,
  });
  expect(createOrReuseSupportCase).toHaveBeenCalledWith(
    expect.not.objectContaining({ appointmentOccurrenceId: "occ-ended" }),
  );
  expect(cases.rows[0]).toMatchObject({ scopeKey: "APPOINTMENT:appointment" });
});

describe("an answer routed by its case", () => {
  const noShowOn = (occ: string, overrides: Row = {}) =>
    openCase({
      id: `report-${occ}`,
      category: "NO_SHOW",
      scopeKey: `OCCURRENCE:${occ}`,
      appointmentOccurrenceId: occ,
      currentNodeId: "start",
      ...overrides,
    });

  it("lands on the no-show case it names past a newer person-handled case on the same session", async () => {
    const report = noShowOn("occ-a");
    const quality = openCase({
      id: "quality-a",
      category: "QUALITY_COMPLAINT",
      scopeKey: "OCCURRENCE:occ-a",
      appointmentOccurrenceId: "occ-a",
      activeChannel: "HUMAN",
      status: "ESCALATED",
    });
    cases.rows.push(report, quality);
    jest.mocked(buildSupportContext).mockResolvedValue(context(false));

    const result = await runSupportTurn("appointment", "learner", {
      chosenOptionId: "expert",
      caseId: String(report.id),
      appointmentOccurrenceId: "occ-a",
    });
    expect(result?.threadId).toBe(report.id);
    expect(report.flowReason).toBe("provider_no_show");
    expect(quality.flowReason).toBeNull();
  });

  it("refuses a guided choice that reaches a person-handled case instead of answering it as accepted", async () => {
    cases.rows.push(
      openCase({
        id: "human-a",
        category: "NO_SHOW",
        scopeKey: "OCCURRENCE:occ-a",
        appointmentOccurrenceId: "occ-a",
        activeChannel: "HUMAN",
        status: "ESCALATED",
      }),
    );
    jest.mocked(buildSupportContext).mockResolvedValue(context(false));
    await expect(
      runSupportTurn("appointment", "learner", {
        chosenOptionId: "expert",
        caseId: "human-a",
      }),
    ).rejects.toMatchObject({
      status: 409,
      body: { code: "OPTION_NOT_AVAILABLE" },
    });
    expect(db.supportCaseMessage.rows).toHaveLength(0);
  });

  it.each([
    [
      "another person's case",
      { requesterUserId: "someone", submitterUserId: "someone" },
      undefined,
    ],
    [
      "a closed case",
      { closedAt: new Date("2026-11-24T08:00:00Z") },
      undefined,
    ],
    ["a case on another session than the turn names", {}, "occ-b"],
  ])(
    "refuses %s with 404 and writes nothing",
    async (_label, overrides, occurrence) => {
      const report = noShowOn("occ-a", overrides);
      cases.rows.push(report);
      jest.mocked(buildSupportContext).mockResolvedValue(context(false));
      await expect(
        runSupportTurn("appointment", "learner", {
          chosenOptionId: "expert",
          caseId: String(report.id),
          ...(occurrence ? { appointmentOccurrenceId: occurrence } : {}),
        }),
      ).rejects.toMatchObject({
        status: 404,
        body: { code: "CASE_UNAVAILABLE" },
      });
      expect(report.flowReason).toBeNull();
      expect(db.supportCaseMessage.rows).toHaveLength(0);
    },
  );
});
