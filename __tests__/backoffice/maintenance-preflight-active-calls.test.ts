/**
 * @jest-environment node
 */

/** The preflight active-call count covers only rooms inside the live window. */

import { GET } from "../../app/api/admin/maintenance/preflight/route";

const NOW = new Date("2026-11-18T10:00:00.000Z");

const mockPrisma = {
  meeting: { count: jest.fn() },
  payment: { count: jest.fn() },
  appointmentOccurrence: { count: jest.fn() },
  consultantPayout: { count: jest.fn() },
  dispute: { count: jest.fn() },
};

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

describe("maintenance preflight active calls", () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(NOW);
    jest.clearAllMocks();
    for (const model of Object.values(mockPrisma))
      model.count.mockResolvedValue(0);
  });
  afterEach(() => jest.useRealTimers());

  it("counts open rooms whose booked end is within 12 h and whose join window has opened", async () => {
    await GET();
    expect(mockPrisma.meeting.count).toHaveBeenCalledWith({
      where: {
        endedAt: null,
        occurrence: {
          startsAt: { lte: new Date("2026-11-18T10:15:00.000Z") },
          endsAt: { gte: new Date("2026-11-17T22:00:00.000Z") },
        },
      },
    });
  });

  it("is SAFE with no warnings when every count is 0", async () => {
    const body = await (await GET()).json();
    expect(body.activeCalls).toBe(0);
    expect(body.recommendation).toBe("SAFE");
    expect(body.warnings).toEqual([]);
  });

  it("is RISKY when a live call is counted", async () => {
    mockPrisma.meeting.count.mockResolvedValue(1);
    const body = await (await GET()).json();
    expect(body.recommendation).toBe("RISKY");
  });
});
