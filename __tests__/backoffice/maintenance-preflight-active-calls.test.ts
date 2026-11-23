/**
 * @jest-environment node
 */

/** Preflight decides "is a call live" from Stream and the open rooms, never the schedule. */

import { GET } from "../../app/api/admin/maintenance/preflight/route";

const NOW = new Date("2026-11-18T10:00:00.000Z");

const mockPrisma = {
  meeting: { findMany: jest.fn() },
  payment: { count: jest.fn() },
  appointmentOccurrence: { count: jest.fn() },
  consultantPayout: { count: jest.fn() },
  dispute: { count: jest.fn() },
};
const mockQueryCalls = jest.fn();
const mockReportSentryError = jest.fn();

jest.mock("../../lib/auth-helpers", () => ({
  requireBackofficeSurface: async () => ({
    session: { user: { id: "op-1", role: "ADMIN" } },
  }),
}));
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  get default() {
    return mockPrisma;
  },
}));
// The real breaker runs; only the vendor client is fake.
jest.mock("../../lib/stream-client", () => ({
  ...jest.requireActual("../../lib/stream-client"),
  isStreamConfigured: () => true,
  getStreamVideoClient: () => ({ video: { queryCalls: mockQueryCalls } }),
}));
jest.mock("../../lib/observability/report", () => ({
  reportSentryError: (...args: unknown[]) => mockReportSentryError(...args),
}));

/** One row of the open-room read, in the shape its `select` returns. */
const room = (streamCallId: string) => ({ streamCallId });
const ongoing = (...ids: string[]) => ({
  calls: ids.map((id) => ({ call: { id, type: "default" } })),
});
/** The preflight answer with these open rooms and these calls Stream lists as ongoing. */
async function preflight(rooms: string[], live: string[]) {
  mockPrisma.meeting.findMany.mockResolvedValue(rooms.map(room));
  mockQueryCalls.mockResolvedValue(ongoing(...live));
  return (await GET()).json();
}

describe("maintenance preflight active calls", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    for (const [name, model] of Object.entries(mockPrisma))
      if (name !== "meeting")
        (model as { count: jest.Mock }).count.mockResolvedValue(0);
    mockPrisma.meeting.findMany.mockResolvedValue([]);
    mockQueryCalls.mockResolvedValue(ongoing());
  });

  it("reads every open room, not a schedule window", async () => {
    jest.useFakeTimers().setSystemTime(NOW);
    try {
      await GET();
    } finally {
      jest.useRealTimers();
    }
    expect(mockPrisma.meeting.findMany).toHaveBeenCalledWith({
      where: { endedAt: null },
      select: { streamCallId: true },
    });
  });

  it("counts a webinar moved to tomorrow while its host is still connected", async () => {
    // No presence row (the join webhook never landed); Stream says the call is live.
    const body = await preflight(
      ["occurrence-moved-webinar"],
      ["occurrence-moved-webinar"],
    );
    expect(mockQueryCalls).toHaveBeenCalledWith({
      filter_conditions: { type: "default", ongoing: true },
      limit: 100,
    });
    expect(body.activeCalls).toBe(1);
    expect(body.recommendation).toBe("RISKY");
  });

  it("counts an open room once when Stream also lists it", async () => {
    const body = await preflight(["occurrence-a"], ["occurrence-a"]);
    expect(body.activeCalls).toBe(1);
  });

  it("counts a live call whose room a late end webhook already closed", async () => {
    // No open room at all; Stream still lists the reconnected session.
    const body = await preflight([], ["occurrence-reconnected-r1a"]);
    expect(body.activeCalls).toBe(1);
    expect(body.recommendation).toBe("RISKY");
  });

  it("counts a room once when Stream lists it under its rotated call id", async () => {
    const body = await preflight(["occurrence-x"], ["occurrence-x-r2b"]);
    expect(body.activeCalls).toBe(1);
  });

  it("warns and cautions when Stream fails with no open room to count", async () => {
    mockQueryCalls.mockRejectedValue(new Error("Stream 503"));
    const body = await (await GET()).json();
    expect(body.activeCalls).toBe(0);
    expect(body.recommendation).toBe("CAUTION");
    expect(body.warnings).toEqual([
      "Stream could not be fully checked, so a live call whose room is already closed may be missing",
    ]);
  });

  it("does not count a provisioned room whose first join failed", async () => {
    const body = await preflight(["occurrence-never"], []);
    expect(body.activeCalls).toBe(0);
    expect(body.recommendation).toBe("SAFE");
    expect(body.warnings).toEqual([]);
  });

  it("counts every uncertain room as active when the Stream lookup fails, reporting once", async () => {
    mockPrisma.meeting.findMany.mockResolvedValue([
      room("occurrence-a"),
      room("occurrence-b"),
    ]);
    mockQueryCalls.mockRejectedValue(new Error("Stream 503"));
    const body = await (await GET()).json();
    expect(body.activeCalls).toBe(2);
    expect(body.recommendation).toBe("RISKY");
    expect(body.warnings).toContain(
      "2 open room(s) could not be checked with Stream and are counted as active",
    );
    expect(mockReportSentryError).toHaveBeenCalledTimes(1);
  });

  it("counts uncertain rooms as active when the Stream lookup times out", async () => {
    jest.useFakeTimers();
    try {
      mockPrisma.meeting.findMany.mockResolvedValue([room("occurrence-a")]);
      mockQueryCalls.mockReturnValue(new Promise(() => undefined));
      const pending = GET();
      await jest.advanceTimersByTimeAsync(5_000);
      const body = await (await pending).json();
      expect(body.activeCalls).toBe(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it("counts an unlisted room as active when Stream's one page is truncated", async () => {
    mockPrisma.meeting.findMany.mockResolvedValue([room("occurrence-a")]);
    mockQueryCalls.mockResolvedValue({ ...ongoing("other"), next: "cursor" });
    const body = await (await GET()).json();
    // The listed call and the unlisted room.
    expect(body.activeCalls).toBe(2);
    expect(body.warnings).toContain(
      "1 open room(s) could not be checked with Stream and are counted as active",
    );
  });

  it("warns that a truncated page may hide calls even with no open rooms", async () => {
    mockPrisma.meeting.findMany.mockResolvedValue([]);
    mockQueryCalls.mockResolvedValue({ ...ongoing("other"), next: "cursor" });
    const body = await (await GET()).json();
    expect(body.activeCalls).toBe(1);
    expect(body.warnings).toContain(
      "Stream could not be fully checked, so a live call whose room is already closed may be missing",
    );
  });
});
