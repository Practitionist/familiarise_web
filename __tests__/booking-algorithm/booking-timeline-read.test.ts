/**
 * @jest-environment node
 */

/**
 * #1319 PR 8 / #448 — the audit-trail read model.
 *
 * Two properties are pinned. The timeline is the MERGE of two sources, so a
 * reschedule proposal has to interleave with the status log by timestamp
 * rather than land in a block at either end; and the read is privileged-only,
 * so an organization or personal scope must be refused before a single query
 * runs (ADR 20 — org roles get no per-session drill-in).
 */

import { getBookingTimeline } from "../../lib/data/booking-history";
import { bookingTraceStep } from "../../lib/backoffice/entity-trace";
import { timelineStepLabel } from "../../components/dashboard/shared/AppointmentTimeline";

const appointmentFindUnique = jest.fn();
const historyFindMany = jest.fn();

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    appointment: {
      findUnique: (args: unknown) => appointmentFindUnique(args),
    },
    bookingStatusHistory: {
      findMany: (args: unknown) => historyFindMany(args),
      fields: { toStatus: "field:toStatus" },
    },
    appointmentParticipant: {
      findMany: async () => [
        { id: "part-1", user: { id: "u-9", name: "Riya" } },
      ],
    },
  },
}));

const PRIVILEGED = { kind: "all" } as const;

type HistoryRow = {
  fromStatus: string;
  toStatus: string;
  reason: string | null;
  actorUser: { id: string; name: string | null } | null;
};

/** One arm of the exclusion OR, evaluated as Postgres would on a stored row. */
function holds(arm: unknown, row: HistoryRow): boolean {
  const text = JSON.stringify(arm);
  if (
    text ===
    JSON.stringify({ NOT: { fromStatus: { equals: "field:toStatus" } } })
  )
    return row.fromStatus !== row.toStatus;
  if (text === JSON.stringify({ reason: { not: null } }))
    return row.reason !== null;
  if (text === JSON.stringify({ actorUserId: { not: null } }))
    return row.actorUser !== null;
  throw new Error(`unknown exclusion arm ${text}`);
}

/** Answers like the database: the WHERE's self-edge exclusion runs before the LIMIT. */
function servedLikeTheDatabase<R extends HistoryRow>(stored: R[]) {
  return async (args: {
    where: { AND?: [unknown, { OR: unknown[] }?] };
    take: number;
  }) => {
    const arms = args.where.AND?.[1]?.OR;
    const kept = arms
      ? stored.filter((row) => arms.some((arm) => holds(arm, row)))
      : stored;
    return kept.slice(0, args.take);
  };
}

function appointmentRow() {
  return {
    id: "appt-1",
    consultationId: "consult-1",
    subscriptionId: null,
    webinarId: null,
    classId: null,
    trial: null,
    occurrences: [{ id: "slot-1" }],
    rescheduleRequests: [
      {
        id: "resched-1",
        status: "ACCEPTED",
        round: 1,
        reason: "clashes with a standup",
        initiatorRole: "CONSULTEE",
        // Deliberately BETWEEN the two history rows below.
        createdAt: new Date("2026-09-02T11:00:00.000Z"),
        resolvedAt: new Date("2026-09-02T12:00:00.000Z"),
        initiatedBy: { id: "user-1", name: "Asha" },
        _count: { proposedTimes: 3 },
      },
    ],
  };
}

function historyRows() {
  return [
    {
      id: "hist-2",
      entity: "OCCURRENCE",
      entityId: "slot-1",
      fromStatus: "SCHEDULED",
      toStatus: "RESCHEDULED",
      reason: null,
      createdAt: new Date("2026-09-02T12:00:00.000Z"),
      actorUser: null,
    },
    {
      id: "hist-1",
      entity: "CONSULTATION",
      entityId: "consult-1",
      fromStatus: "PENDING",
      toStatus: "APPROVED",
      reason: "approved by the consultant",
      createdAt: new Date("2026-09-02T10:00:00.000Z"),
      actorUser: { id: "user-2", name: "Ravi" },
    },
  ];
}

describe("getBookingTimeline", () => {
  beforeEach(() => {
    appointmentFindUnique.mockResolvedValue(appointmentRow());
    historyFindMany.mockResolvedValue(historyRows());
  });

  it("merges status history with reschedule proposals, newest first", async () => {
    const timeline = await getBookingTimeline("appt-1", PRIVILEGED);

    expect(timeline).not.toBeNull();
    expect(timeline!.entries.map((entry) => entry.id)).toEqual([
      "hist-2",
      "resched-1",
      "hist-1",
    ]);

    const [slotMove, proposal, approval] = timeline!.entries;
    expect(slotMove).toMatchObject({
      kind: "status",
      entity: "OCCURRENCE",
      from: "SCHEDULED",
      to: "RESCHEDULED",
      actor: null,
    });
    // The proposal is the row the RescheduleRequest table contributes: it was
    // proposed, and where it stands now rides beside it.
    expect(proposal).toMatchObject({
      kind: "reschedule",
      entity: "RESCHEDULE_REQUEST",
      from: null,
      to: "PROPOSED",
      outcome: "ACCEPTED",
      proposedSlotCount: 3,
      actor: { id: "user-1", name: "Asha" },
    });
    expect(approval).toMatchObject({ kind: "status", to: "APPROVED" });
    expect(timeline!.truncated).toBe(false);

    // The trail is resolved by entityId, not by the (always NULL) appointmentId
    // column — the SLOT and RESCHEDULE_REQUEST rows only surface because of it.
    // Each id is paired with the entity its writer stamps, so a same-id row of
    // another type cannot enter another appointment's trail.
    const call = historyFindMany.mock.calls[0][0];
    expect(call.where.AND[0].OR).toEqual([
      { appointmentId: "appt-1" },
      { entity: "CONSULTATION", entityId: { in: ["consult-1"] } },
      { entity: "OCCURRENCE", entityId: { in: ["slot-1"] } },
      { entity: "RESCHEDULE_REQUEST", entityId: { in: ["resched-1"] } },
    ]);
    // The window is cut in the database, so equal timestamps need a second key.
    expect(call.orderBy).toEqual([{ createdAt: "desc" }, { id: "asc" }]);
  });

  it("hides a self-edge with neither reason nor actor, and keeps one that has either", async () => {
    historyFindMany.mockImplementation(
      servedLikeTheDatabase([
        {
          id: "hist-self-bare",
          entity: "SUBSCRIPTION",
          entityId: "sub-1",
          fromStatus: "APPROVED",
          toStatus: "APPROVED",
          reason: null,
          createdAt: new Date("2026-09-03T10:00:00.000Z"),
          actorUser: null,
        },
        {
          id: "hist-self-why",
          entity: "SUBSCRIPTION",
          entityId: "sub-1",
          fromStatus: "APPROVED",
          toStatus: "APPROVED",
          reason: "plan extended by ops",
          createdAt: new Date("2026-09-03T09:00:00.000Z"),
          actorUser: null,
        },
        {
          id: "hist-self-who",
          entity: "SUBSCRIPTION",
          entityId: "sub-1",
          fromStatus: "APPROVED",
          toStatus: "APPROVED",
          reason: null,
          createdAt: new Date("2026-09-03T08:00:00.000Z"),
          actorUser: { id: "operator-1", name: "Operator" },
        },
        ...historyRows(),
      ]),
    );
    const timeline = await getBookingTimeline("appt-1", PRIVILEGED);
    const ids = timeline!.entries.map((entry) => entry.id);
    expect(ids).not.toContain("hist-self-bare");
    expect(ids).toContain("hist-self-why");
    // An actor makes a same-status row an audit record.
    expect(ids).toContain("hist-self-who");
  });

  it("lists an answered reschedule as one proposal and one outcome, in the drawer and the trace", async () => {
    historyFindMany.mockResolvedValue([
      {
        id: "hist-answer",
        entity: "RESCHEDULE_REQUEST",
        entityId: "resched-1",
        fromStatus: "PENDING_REVIEW",
        toStatus: "ACCEPTED",
        reason: null,
        createdAt: new Date("2026-09-02T12:00:00.000Z"),
        actorUser: { id: "user-2", name: "Ravi" },
      },
    ]);
    const { entries } = (await getBookingTimeline("appt-1", PRIVILEGED))!;

    const trace = entries.map(bookingTraceStep);
    expect(trace.map((t) => t.status)).toEqual([
      "Reschedule request: pending review → accepted",
      "Reschedule proposed",
    ]);
    expect(trace[1].detail).toBe("clashes with a standup · now accepted");

    const drawer = entries.map(timelineStepLabel);
    expect(drawer).toEqual(["Pending Review → Accepted", "Proposed"]);
    expect(drawer.filter((label) => label.includes("Accepted"))).toHaveLength(
      1,
    );
  });

  it("excludes hidden self-edges in the query, so 200 of them cannot push a real move out of the window", async () => {
    const selfEdges = Array.from({ length: 200 }, (_, index) => ({
      id: `self-${String(index).padStart(3, "0")}`,
      entity: "CONSULTATION",
      entityId: "consult-1",
      fromStatus: "APPROVED",
      toStatus: "APPROVED",
      reason: null,
      createdAt: new Date(Date.UTC(2026, 8, 3, 13, 0, index)),
      actorUser: null,
    }));
    const realMove = historyRows()[1];
    const stored = [...selfEdges.reverse(), realMove];
    historyFindMany.mockImplementation(servedLikeTheDatabase(stored));

    const timeline = await getBookingTimeline("appt-1", PRIVILEGED);

    expect(historyFindMany.mock.calls[0][0].where.AND[1]).toEqual({
      OR: [
        { NOT: { fromStatus: { equals: "field:toStatus" } } },
        { reason: { not: null } },
        { actorUserId: { not: null } },
      ],
    });
    expect(timeline!.entries.map((entry) => entry.id)).toContain("hist-1");
    expect(timeline!.truncated).toBe(false);
  });

  it("reads the booking's own entities and its attendees' seat rows", async () => {
    historyFindMany.mockResolvedValue(historyRows());

    await getBookingTimeline("appt-1", PRIVILEGED);

    expect(historyFindMany.mock.calls[0][0].where.AND[2]).toEqual({
      entity: {
        in: [
          "CONSULTATION",
          "SUBSCRIPTION",
          "WEBINAR",
          "CLASS",
          "TRIAL",
          "RESCHEDULE_REQUEST",
          "OCCURRENCE",
          "SEAT",
        ],
      },
    });
  });

  it("reads a seat row that keeps its status as its reason, never as a status edge", async () => {
    historyFindMany.mockResolvedValue([
      {
        id: "h-lift",
        entity: "SEAT",
        entityId: "part-1",
        fromStatus: "CANCELLED",
        toStatus: "CANCELLED",
        reason: "block_lifted",
        createdAt: new Date("2026-11-18T10:00:00.000Z"),
        actorUser: { id: "staff-1", name: "Grace" },
      },
    ]);
    const { entries } = (await getBookingTimeline("appt-1", PRIVILEGED))!;
    expect(
      entries.filter((e) => e.entity === "SEAT").map(timelineStepLabel),
    ).toEqual(["Allowed back: may register again"]);
  });

  it("reads an outcome reason token as words", async () => {
    historyFindMany.mockResolvedValue([
      {
        ...historyRows()[0],
        id: "h-sweep",
        reason: "session-outcome:NOBODY_JOINED",
      },
      {
        ...historyRows()[1],
        id: "h-ops",
        reason: "ops:session.set-outcome:HELD",
      },
    ]);
    const { entries } = (await getBookingTimeline("appt-1", PRIVILEGED))!;
    const reasons = Object.fromEntries(entries.map((e) => [e.id, e.reason]));
    expect(reasons["h-sweep"]).toBe("Outcome sweep: Nobody joined");
    expect(reasons["h-ops"]).toBe("Set by ops: Held");
  });

  it("flags truncation when the merge overflows the limit", async () => {
    // Exactly the limit in status rows, so the over-fetch check alone sees
    // nothing: the proposal merged in is what pushes an event off the end.
    historyFindMany.mockResolvedValue(
      Array.from({ length: 200 }, (_, index) => ({
        id: `hist-${String(index).padStart(3, "0")}`,
        entity: "OCCURRENCE",
        entityId: "slot-1",
        fromStatus: "SCHEDULED",
        toStatus: "COMPLETED",
        reason: null,
        createdAt: new Date(Date.UTC(2026, 8, 2, 13, 0, index)),
        actorUser: null,
      })),
    );

    const timeline = await getBookingTimeline("appt-1", PRIVILEGED);

    expect(timeline!.entries).toHaveLength(200);
    expect(timeline!.truncated).toBe(true);
  });

  it("never selects an actor's email", async () => {
    await getBookingTimeline("appt-1", PRIVILEGED);

    const actorSelect =
      historyFindMany.mock.calls[0][0].select.actorUser.select;
    expect(actorSelect).toEqual({ id: true, name: true });
  });

  it("refuses a non-privileged scope before touching the database", async () => {
    await expect(
      // Cast: the type signature already rejects this, and the throw is the
      // backstop for an untyped caller.
      getBookingTimeline("appt-1", { kind: "org", orgId: "org-1" } as never),
    ).rejects.toThrow(/privileged-only/i);

    await expect(
      getBookingTimeline("appt-1", { kind: "personal" } as never),
    ).rejects.toThrow(/privileged-only/i);

    expect(appointmentFindUnique).not.toHaveBeenCalled();
    expect(historyFindMany).not.toHaveBeenCalled();
  });

  it("returns null for an appointment that does not exist", async () => {
    appointmentFindUnique.mockResolvedValue(null);
    await expect(getBookingTimeline("missing", PRIVILEGED)).resolves.toBeNull();
    expect(historyFindMany).not.toHaveBeenCalled();
  });
});
