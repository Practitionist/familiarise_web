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

  await runSupportTurn("appointment", "learner", { category: "NO_SHOW" });
  expect(createOrReuseSupportCase).toHaveBeenCalledWith(
    expect.objectContaining({
      category: "NO_SHOW",
      appointmentOccurrenceId: "occ-ended",
    }),
  );
  const noShow = cases.rows.find((r) => r.category === "NO_SHOW")!;
  expect(noShow).toMatchObject({ scopeKey: "OCCURRENCE:occ-ended" });
  expect(other).toMatchObject({ category: "PAYMENT_STATUS", flowReason: null });

  const result = await runSupportTurn("appointment", "learner", {
    chosenOptionId: "expert",
  });
  expect(result).toMatchObject({ threadId: noShow.id, escalated: true });
  expect(noShow.flowReason).toBe("provider_no_show");
});

it("files on the session the turn names over the default one", async () => {
  jest.mocked(buildSupportContext).mockResolvedValue(context(false));
  await runSupportTurn("appointment", "learner", {
    category: "NO_SHOW",
    appointmentOccurrenceId: "occ-earlier",
  });
  expect(cases.rows[0]).toMatchObject({ scopeKey: "OCCURRENCE:occ-earlier" });
});

it("keeps the first terminal's reason when a later answer on the same case differs", async () => {
  jest.mocked(buildSupportContext).mockResolvedValue(context(true));
  await runSupportTurn("appointment", "host", { category: "NO_SHOW" });
  await runSupportTurn("appointment", "host", { chosenOptionId: "client" });
  const noShow = cases.rows[0];
  expect(noShow).toMatchObject({
    status: "RESOLVED",
    flowReason: "attendee_no_show",
  });

  // The same session's open case takes the second report; its reason stands.
  await runSupportTurn("appointment", "host", { category: "NO_SHOW" });
  await runSupportTurn("appointment", "host", { chosenOptionId: "attended" });
  expect(cases.rows).toHaveLength(1);
  expect(noShow).toMatchObject({
    activeChannel: "HUMAN",
    flowReason: "attendee_no_show",
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
