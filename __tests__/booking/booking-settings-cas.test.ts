/**
 * @jest-environment node
 */

// Invariant: only the booking-settings PATCH writes bookingMode /
// acceptingRequests / maxOpenRequests, and it writes only while every value
// the screen showed still holds; the whole-profile PUT refuses those keys.

jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));
jest.mock("../../lib/auth-server", () => ({ getSession: jest.fn() }));
jest.mock("../../lib/data/public-cache", () => ({
  purgeExpertSurfaces: jest.fn(),
}));
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    consultantProfile: {
      findUnique: jest.fn(),
      updateMany: jest.fn(),
      update: jest.fn(),
    },
  },
}));

import { NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import { getSession } from "@/lib/auth-server";
import { PATCH, PUT } from "@/app/api/user/consultants/[id]/route";

const profile = prisma.consultantProfile as unknown as {
  findUnique: jest.Mock;
  updateMany: jest.Mock;
  update: jest.Mock;
};
const params = { params: Promise.resolve({ id: "cp-1" }) };
const request = (method: "PATCH" | "PUT", body: unknown) =>
  new NextRequest("http://localhost/api/user/consultants/cp-1", {
    method,
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });

let stored: {
  bookingMode: string;
  acceptingRequests: boolean;
  maxOpenRequests: number | null;
};

beforeEach(() => {
  jest.clearAllMocks();
  stored = {
    bookingMode: "INSTANT",
    acceptingRequests: true,
    maxOpenRequests: 5,
  };
  (getSession as jest.Mock).mockResolvedValue({ user: { id: "u-1" } });
  profile.findUnique.mockImplementation(
    async ({ select }: { select: Record<string, boolean> }) =>
      select.userId ? { userId: "u-1" } : { ...stored },
  );
  // A tiny CAS: the write lands only if every WHERE value still matches.
  profile.updateMany.mockImplementation(
    async ({
      where,
      data,
    }: {
      where: Record<string, unknown>;
      data: Partial<typeof stored>;
    }) => {
      const { id: _id, ...expected } = where;
      const holds = Object.entries(expected).every(
        ([key, value]) => stored[key as keyof typeof stored] === value,
      );
      if (!holds) return { count: 0 };
      stored = { ...stored, ...data };
      return { count: 1 };
    },
  );
});

describe("PATCH booking settings (CAS)", () => {
  it("writes the changed field only, guarded by the value it replaces", async () => {
    const res = await PATCH(
      request("PATCH", {
        set: { maxOpenRequests: 8 },
        expect: { maxOpenRequests: 5 },
      }),
      params,
    );
    expect(res.status).toBe(200);
    expect(profile.updateMany).toHaveBeenCalledWith({
      where: { id: "cp-1", maxOpenRequests: 5 },
      data: { maxOpenRequests: 8 },
    });
    expect((await res.json()).data).toEqual({
      bookingMode: "INSTANT",
      acceptingRequests: true,
      maxOpenRequests: 8,
    });
  });

  it("a stale tab cannot undo a pause made elsewhere: 409 SETTINGS_CHANGED", async () => {
    // Tab B pauses.
    await PATCH(
      request("PATCH", {
        set: { acceptingRequests: false },
        expect: { acceptingRequests: true },
      }),
      params,
    );
    // Tab A still shows "taking bookings" and flips it back on.
    const res = await PATCH(
      request("PATCH", {
        set: { acceptingRequests: true },
        expect: { acceptingRequests: true },
      }),
      params,
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("SETTINGS_CHANGED");
    expect(body.data.acceptingRequests).toBe(false);
    expect(stored.acceptingRequests).toBe(false);
  });

  it("a different field saved from a stale tab keeps the other tab's pause", async () => {
    await PATCH(
      request("PATCH", {
        set: { acceptingRequests: false },
        expect: { acceptingRequests: true },
      }),
      params,
    );
    const res = await PATCH(
      request("PATCH", {
        set: { maxOpenRequests: 9 },
        expect: { maxOpenRequests: 5 },
      }),
      params,
    );
    expect(res.status).toBe(200);
    expect(stored).toMatchObject({
      acceptingRequests: false,
      maxOpenRequests: 9,
    });
  });

  it("refuses a change without the value it replaces", async () => {
    const res = await PATCH(
      request("PATCH", { set: { acceptingRequests: false }, expect: {} }),
      params,
    );
    expect(res.status).toBe(400);
    expect(profile.updateMany).not.toHaveBeenCalled();
  });
});

describe("PUT whole profile", () => {
  it("refuses the booking settings: only the PATCH may write them", async () => {
    const res = await PUT(
      request("PUT", {
        scheduleType: "WEEKLY",
        domainId: "00000000-0000-4000-8000-000000000001",
        subDomainIds: [],
        tagIds: [],
        experience: 3,
        availabilityWindowsWeekly: [
          {
            dayOfWeekforStartTimeInUTC: "MONDAY",
            dayOfWeekforEndTimeInUTC: "MONDAY",
            startsAt: "2026-09-21T04:30:00.000Z",
            endsAt: "2026-09-21T06:30:00.000Z",
          },
        ],
        acceptingRequests: true,
      }),
      params,
    );
    expect(res.status).toBe(400);
    expect(JSON.stringify((await res.json()).details)).toContain(
      "acceptingRequests",
    );
    expect(profile.update).not.toHaveBeenCalled();
    expect(profile.updateMany).not.toHaveBeenCalled();
  });
});
