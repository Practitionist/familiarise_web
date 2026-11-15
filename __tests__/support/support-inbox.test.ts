/**
 * #1527 — the Support inbox's case model: an escalated conversation is one
 * case (its ticket), the views select the right table, the merge reproduces
 * one ORDER BY, and the first-response stat is the plain mean.
 */

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    supportCase: {
      findMany: jest.fn(),
      count: jest.fn(),
      fields: { statutoryDueAt: "statutoryDueAt" },
    },
  },
}));

import prisma from "../../lib/prisma";
import { readInboxPage } from "@/lib/support/case-read";
import { caseKeyOf } from "@/lib/support/case-key";
import {
  averageFirstResponseMs,
  compareCasesBySla,
  inboxCaseWhere,
  parseInboxFilters,
} from "@/lib/support/inbox-query";

const filters = (query: Record<string, string>) =>
  parseInboxFilters((k) => query[k] ?? null, "me");

describe("inbox views", () => {
  it("uses canonical open human cases for Needs reply", () => {
    const f = filters({});
    expect(f.view).toBe("needs-reply");
    expect(inboxCaseWhere(f)).toEqual({
      AND: [
        { deletedAt: null },
        { deletedAt: null, status: { notIn: ["RESOLVED", "CLOSED"] } },
        { activeChannel: "HUMAN", awaitingUserSince: null },
      ],
    });
  });
  it("filters sessions, assignments, and self serve on the same model", () => {
    expect(JSON.stringify(inboxCaseWhere(filters({ view: "mine" })))).toContain(
      '"assignedToId":"me"',
    );
    expect(
      JSON.stringify(inboxCaseWhere(filters({ view: "self-serve" }))),
    ).toContain('"activeChannel":"SELF_SERVE"');
    expect(
      JSON.stringify(
        inboxCaseWhere(filters({ view: "all", scope: "session" })),
      ),
    ).toContain('"appointmentId":{"not":null}');
    expect(
      JSON.stringify(
        inboxCaseWhere(filters({ view: "all", scope: "platform" })),
      ),
    ).toContain('"appointmentId":null');
  });
});

describe("averageFirstResponseMs", () => {
  it("averages reply minus creation and skips unanswered tickets", () => {
    const created = new Date("2026-09-01T00:00:00Z");
    expect(
      averageFirstResponseMs([
        {
          createdAt: created,
          firstAgentReplyAt: new Date("2026-09-01T01:00:00Z"),
        },
        {
          createdAt: created,
          firstAgentReplyAt: new Date("2026-09-01T03:00:00Z"),
        },
        { createdAt: created, firstAgentReplyAt: null },
      ]),
    ).toBe(2 * 3_600_000);
    expect(averageFirstResponseMs([])).toBeNull();
  });
});

describe("readInboxPage SLA paging", () => {
  type Row = {
    id: string;
    createdAt: Date;
    lastMessageAt: Date | null;
    acknowledgedAt: Date | null;
    ackDueAt: Date | null;
    resolutionDueAt: Date | null;
  } & Record<string, unknown>;
  type Cond = Record<string, unknown>;
  type Order = Record<string, "asc" | "desc" | { sort: "asc" | "desc" }>;

  const day = (n: number) => new Date(Date.UTC(2026, 8, 1) + n * 3_600_000);
  const row = (
    i: number,
    acked: boolean,
    ackDue: number | null,
    resDue: number | null,
  ): Row => ({
    id: `tk${String(i).padStart(3, "0")}`,
    referenceNumber: null,
    title: `T${i}`,
    description: "",
    priority: "MEDIUM",
    category: null,
    issueType: null,
    status: "OPEN",
    createdAt: day(i),
    lastMessageAt: day(i),
    acknowledgedAt: acked ? day(0) : null,
    ackDueAt: ackDue === null ? null : day(ackDue),
    resolutionDueAt: resDue === null ? null : day(resDue),
    resolvedAt: null,
    awaitingUserSince: null,
    pausedSeconds: 0,
    requester: { id: "u", name: "U" },
    activeChannel: "HUMAN",
    appointmentId: null,
    callbackPhone: null,
    assignedTo: null,
    deletedAt: null,
  });
  // Acknowledged rows: ackDueAt order is the reverse of resolutionDueAt order.
  const fixtures = [
    ...Array.from({ length: 30 }, (_, i) => row(i, true, i, 100 - i)),
    ...Array.from({ length: 5 }, (_, i) => row(40 + i, false, null, 50 + i)),
  ];

  const matches = (r: Row, c: Cond): boolean =>
    Object.entries(c).every(([k, v]) => {
      if (k === "AND") return (v as Cond[]).every((o) => matches(r, o));
      if (k === "OR") return (v as Cond[]).some((o) => matches(r, o));
      if (v === null) return r[k] === null;
      if (typeof v === "object" && v && "not" in v) return r[k] !== null;
      return true; // the view's base filter: every fixture qualifies
    });
  const byOrder = (orders: Order[]) => (a: Row, b: Row) => {
    for (const o of orders) {
      const [k, spec] = Object.entries(o)[0];
      const dir =
        (typeof spec === "string" ? spec : spec.sort) === "asc" ? 1 : -1;
      const av = a[k] as Date | string | null;
      const bv = b[k] as Date | string | null;
      if (av === null || bv === null) {
        if (av !== bv) return av === null ? 1 : -1;
        continue;
      }
      if (av < bv) return -dir;
      if (av > bv) return dir;
    }
    return 0;
  };

  beforeEach(() => {
    (prisma.supportCase.findMany as jest.Mock).mockImplementation(
      async (args: { where: Cond; orderBy?: Order[]; take?: number }) => {
        const ids = (args.where.id as { in?: string[] } | undefined)?.in;
        if (ids) return fixtures.filter((r) => ids.includes(r.id));
        const parts = (args.where.AND as Cond[]).slice(1);
        return fixtures
          .filter((r) => parts.every((c) => matches(r, c)))
          .sort(byOrder(args.orderBy ?? []))
          .slice(0, args.take);
      },
    );
    (prisma.supportCase.count as jest.Mock).mockResolvedValue(fixtures.length);
  });

  it("pages are disjoint and together equal the full SLA order", async () => {
    const f = filters({ view: "mine", sort: "sla" });
    const [p1, p2] = await Promise.all([1, 2].map((p) => readInboxPage(f, p)));
    const k1 = p1.rows.map((r) => r.key);
    const k2 = p2.rows.map((r) => r.key);
    expect(k1.filter((k) => k2.includes(k))).toEqual([]);
    const expected = fixtures
      .map((r) => ({
        ...r,
        ackDueAt: r.acknowledgedAt ? null : r.ackDueAt,
        key: caseKeyOf({ kind: "case", id: r.id }),
      }))
      .sort(compareCasesBySla)
      .map((r) => r.key);
    expect([...k1, ...k2]).toEqual(expected);
  });
});
