/**
 * @jest-environment node
 */

/**
 * E2E F-4 — the staff queue rendered uuid-tail labels (e.g. `66A3CB17`) for
 * tickets that HAVE a referenceNumber, because the list payload omitted it.
 *
 * #1527 — the queue is now the Support inbox (lib/support/case-read.ts); this
 * pins the same fix there: a ticket case carries its `FAM-` reference.
 */

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    supportTicket: { findMany: jest.fn(), count: jest.fn() },
    appointmentSupportThread: { findMany: jest.fn(), count: jest.fn() },
  },
}));

import prisma from "../../lib/prisma";
import { readInboxPage } from "../../lib/support/case-read";
import { parseInboxFilters } from "../../lib/support/inbox-query";

const TICKET_ROW = {
  id: "0f8fad5b-6bd8-4e9d-9c9f-aa1166a3cb17",
  referenceNumber: "FAM-2026-000006",
  title: "Refund not received",
  priority: "HIGH",
  status: "OPEN",
  category: null,
  issueType: "REFUND_REQUEST",
  createdAt: new Date("2026-03-01T00:00:00Z"),
  lastMessageAt: new Date("2026-03-01T00:00:00Z"),
  ackDueAt: null,
  acknowledgedAt: null,
  resolutionDueAt: null,
  resolvedAt: null,
  awaitingUserSince: null,
  pausedSeconds: 0,
  user: { id: "u1", name: "U", email: "u@x.test" },
  assignedTo: null,
  appointmentSupportThread: null,
};

beforeEach(() => {
  (prisma.supportTicket.findMany as jest.Mock).mockResolvedValue([TICKET_ROW]);
  (prisma.supportTicket.count as jest.Mock).mockResolvedValue(1);
  (prisma.appointmentSupportThread.findMany as jest.Mock).mockResolvedValue([]);
  (prisma.appointmentSupportThread.count as jest.Mock).mockResolvedValue(0);
});

describe("Support inbox list (E2E F-4)", () => {
  it("a ticket case carries its referenceNumber and topic", async () => {
    const filters = parseInboxFilters(
      (k) => (k === "view" ? "all" : null),
      "s1",
    );
    const page = await readInboxPage(filters, 1, { showEmail: false });
    expect(page.total).toBe(1);
    expect(page.rows[0]).toMatchObject({
      key: `t_${TICKET_ROW.id}`,
      reference: "FAM-2026-000006",
      topic: "payments",
      scope: "platform",
      requester: { id: "u1", name: "U", email: null },
    });
  });
});
