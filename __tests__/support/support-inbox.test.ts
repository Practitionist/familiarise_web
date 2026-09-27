/**
 * #1527 — the Support inbox's case model: an escalated conversation is one
 * case (its ticket), the views select the right table, the merge reproduces
 * one ORDER BY, and the first-response stat is the plain mean.
 */

import {
  averageFirstResponseMs,
  inboxThreadWhere,
  inboxTicketWhere,
  mergeCasePage,
  parseInboxFilters,
} from "@/lib/support/inbox-query";

const filters = (query: Record<string, string>) =>
  parseInboxFilters((k) => query[k] ?? null, "me");

describe("inbox views", () => {
  it("defaults to Needs reply and only lists unescalated conversations", () => {
    const f = filters({});
    expect(f.view).toBe("needs-reply");
    expect(JSON.stringify(inboxThreadWhere(f))).toContain(
      '"supportTicketId":null',
    );
    expect(JSON.stringify(inboxTicketWhere(f))).toContain(
      '"awaitingUserSince":null',
    );
  });

  it("routes each view to the tables that can hold it", () => {
    expect(inboxTicketWhere(filters({ view: "self-serve" }))).toBeNull();
    expect(inboxThreadWhere(filters({ view: "mine" }))).toBeNull();
    expect(
      inboxThreadWhere(filters({ view: "all", priority: "HIGH" })),
    ).toBeNull();
    expect(
      inboxThreadWhere(filters({ view: "all", scope: "platform" })),
    ).toBeNull();
    expect(
      inboxTicketWhere(filters({ view: "all", status: "ESCALATED" })),
    ).toBeNull();
    expect(
      JSON.stringify(inboxTicketWhere(filters({ view: "mine" }))),
    ).toContain('"assignedToId":"me"');
  });
});

describe("mergeCasePage", () => {
  const at = (key: string, last: string | null, created: string) => ({
    key,
    lastMessageAt: last ? new Date(last) : null,
    createdAt: new Date(created),
  });

  it("orders by last activity, never-active last, then pages the union", () => {
    const tickets = [
      at("t_b", "2026-09-03", "2026-09-01"),
      at("t_a", null, "2026-09-05"),
    ];
    const threads = [at("s_c", "2026-09-04", "2026-09-02")];
    expect(mergeCasePage(tickets, threads, 0, 2).map((r) => r.key)).toEqual([
      "s_c",
      "t_b",
    ]);
    expect(mergeCasePage(tickets, threads, 2, 2).map((r) => r.key)).toEqual([
      "t_a",
    ]);
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
