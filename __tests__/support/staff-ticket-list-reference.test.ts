/**
 * @jest-environment node
 */

/**
 * E2E F-4 — the staff queue rendered uuid-tail labels (e.g. `66A3CB17`) for
 * cases that HAVE a referenceNumber, because the list payload omitted it.
 *
 * #1527 — the queue is the Support inbox (lib/support/case-read.ts) over the
 * canonical SupportCase table; this pins the same fix there: a case carries
 * its `FAM-` reference under a `c_`-prefixed key.
 */

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    supportCase: { findMany: jest.fn(), count: jest.fn() },
    payment: { findMany: jest.fn() },
  },
}));

import prisma from "../../lib/prisma";
import { readInboxPage } from "../../lib/support/case-read";
import { parseInboxFilters } from "../../lib/support/inbox-query";

const CASE_ROW = {
  id: "0f8fad5b-6bd8-4e9d-9c9f-aa1166a3cb17",
  referenceNumber: "FAM-2026-000006",
  title: "Refund not received",
  priority: "HIGH",
  status: "OPEN",
  category: null,
  issueType: "REFUND_REQUEST",
  activeChannel: "HUMAN",
  appointmentId: null,
  callbackPhone: null,
  createdAt: new Date("2026-03-01T00:00:00Z"),
  lastMessageAt: new Date("2026-03-01T00:00:00Z"),
  ackDueAt: null,
  acknowledgedAt: null,
  resolutionDueAt: null,
  resolvedAt: null,
  awaitingUserSince: null,
  pausedSeconds: 0,
  requester: { id: "u1", name: "U" },
  assignedTo: null,
  subjects: [],
};

beforeEach(() => {
  jest.clearAllMocks();
  (prisma.supportCase.findMany as jest.Mock).mockResolvedValue([CASE_ROW]);
  (prisma.supportCase.count as jest.Mock).mockResolvedValue(1);
  (prisma.payment.findMany as jest.Mock).mockResolvedValue([]);
});

describe("Support inbox list (E2E F-4)", () => {
  it("a case carries its referenceNumber and topic", async () => {
    const filters = parseInboxFilters(
      (k) => (k === "view" ? "all" : null),
      "s1",
    );
    const page = await readInboxPage(filters, 1);
    expect(page.total).toBe(1);
    expect(page.rows[0]).toMatchObject({
      key: `c_${CASE_ROW.id}`,
      kind: "case",
      reference: "FAM-2026-000006",
      topic: "payments",
      scope: "platform",
      requester: { id: "u1", name: "U" },
    });
    // Contact fields are on the case detail only.
    expect(page.rows[0].requester).not.toHaveProperty("email");
    expect(page.rows[0].requester).not.toHaveProperty("phone");
  });
});
