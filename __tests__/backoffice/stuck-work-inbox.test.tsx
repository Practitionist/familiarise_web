import { render, screen } from "@testing-library/react";

const HOUR = 60 * 60 * 1000;
const mockNow = new Date("2026-11-01T10:00:00Z");

type Args = { orderBy: Array<Record<string, "asc" | "desc">>; take: number };
const mockRows = (rows: Array<Record<string, unknown>>, field: string) =>
  jest.fn(async ({ orderBy, take }: Args) => {
    const at = (r: Record<string, unknown>) => (r[field] as Date).getTime();
    const asc = [...rows].sort((a, b) => at(a) - at(b));
    return (orderBy[0][field] === "asc" ? asc : asc.reverse()).slice(0, take);
  });
const mockEmails = Array.from({ length: 60 }, (_, i) => ({
  id: `e${String(i).padStart(2, "0")}`,
  emailType: "BOOKING",
  status: "DEAD_LETTER",
  attempts: 5,
  lastError: "bounced",
  nextRetryAt: null,
  createdAt: new Date(mockNow.getTime() - (100 - i) * HOUR),
  updatedAt: new Date(mockNow.getTime() - (100 - i) * HOUR),
}));
const mockDisputes = [
  {
    id: "d-late",
    paymentId: "p1",
    status: "NEEDS_RESPONSE",
    dueBy: new Date(mockNow.getTime() - 42 * 24 * HOUR),
  },
  {
    id: "d-soon",
    paymentId: "p2",
    status: "NEEDS_RESPONSE",
    dueBy: new Date(mockNow.getTime() + 5 * HOUR),
  },
];
const mockEmpty = () => ({
  findMany: jest.fn(async () => []),
  count: jest.fn(async () => 0),
});
const mockDb = {
  payment: mockEmpty(),
  consultantPayout: mockEmpty(),
  organizationPayout: mockEmpty(),
  organizationInvoice: mockEmpty(),
  dispute: {
    findMany: mockRows(mockDisputes, "dueBy"),
    count: jest.fn(async () => 2),
  },
  webhookEvent: mockEmpty(),
  failedEmail: {
    findMany: mockRows(mockEmails, "updatedAt"),
    count: jest.fn(async () => 60),
  },
  notificationOutbox: mockEmpty(),
};
// The refunded-live-bookings selection, empty here.
const mockQueryRaw = jest.fn(async () => []);
jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  get default() {
    return { ...mockDb, $queryRaw: mockQueryRaw };
  },
}));

import { NeedsAttentionInbox } from "@/components/dashboard/backoffice/NeedsAttentionInbox";
import { readNeedsAttention } from "@/lib/backoffice/needs-attention";

it("shows each queue's total, its newest items beside the oldest, and disputes against the deadline", async () => {
  const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  const queues = await readNeedsAttention(mockNow);
  expect(warn).not.toHaveBeenCalled();
  const emails = queues.find((q) => q.key === "emailRetries")?.items;
  expect(emails?.total).toBe(60);
  expect(emails?.oldest.map((e) => e.id)).toEqual(
    mockEmails.slice(0, 25).map((e) => e.id),
  );
  expect(emails?.newest.map((e) => e.id)).toEqual(
    mockEmails.slice(35).map((e) => e.id),
  );

  const statements = Object.values(mockDb).reduce(
    (n, m) => n + m.findMany.mock.calls.length + m.count.mock.calls.length,
    mockQueryRaw.mock.calls.length,
  );
  expect(statements).toBe(12);

  render(<NeedsAttentionInbox queues={queues} basePath="/dashboard/admin" />);
  expect(screen.getByText("10 more in between")).toBeTruthy();
  expect(
    screen.getByText(/60 waiting; showing the oldest 25 and the newest 25/),
  ).toBeTruthy();
  expect(screen.getByText("overdue by 42 d 0 h")).toBeTruthy();
  expect(screen.getByText("due in 5 h 0 min")).toBeTruthy();
  expect(screen.getAllByText(/^Listed when at any age\./)).toHaveLength(2);
});
