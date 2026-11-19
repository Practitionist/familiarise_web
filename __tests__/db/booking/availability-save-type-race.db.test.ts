/**
 * An availability save replaces the rows of the schedule type it read before
 * its transaction. A switch that commits in between must make that save refuse,
 * so the switched hours survive.
 */
import { NextRequest } from "next/server";
import prisma from "../../../lib/prisma";
import { futureAt, HOUR_MS, seedHost } from "./harness";

const sessionUser = { current: { id: "" } as Record<string, unknown> };
jest.mock("../../../lib/auth-server", () => ({
  getSession: async () => ({ user: sessionUser.current }),
}));
jest.mock("../../../lib/data/public-cache", () => ({
  purgeExpertSurfaces: () => undefined,
}));

// The route's seam between its profile read and its transaction: a one-shot
// hook runs there, standing in for a second request that commits first.
const beforeNextTransaction: { current: (() => Promise<void>) | null } = {
  current: null,
};
jest.mock("../../../lib/db/serializable-retry", () => {
  const actual = jest.requireActual<
    typeof import("../../../lib/db/serializable-retry")
  >("../../../lib/db/serializable-retry");
  return {
    ...actual,
    withSerializableRetry: async <T>(
      fn: () => Promise<T>,
      maxRetries?: number,
    ) => {
      const hook = beforeNextTransaction.current;
      beforeNextTransaction.current = null;
      if (hook) await hook();
      return actual.withSerializableRetry(fn, maxRetries);
    },
  };
});

import { PUT } from "../../../app/api/user/consultants/[id]/route";

async function save(
  consultantProfileId: string,
  domainId: string,
  hours:
    | { scheduleType: "WEEKLY"; availabilityWindowsWeekly: object[] }
    | { scheduleType: "CUSTOM"; availabilityWindowsCustom: object[] },
) {
  const res = await PUT(
    new NextRequest(
      `http://localhost/api/user/consultants/${consultantProfileId}`,
      {
        method: "PUT",
        body: JSON.stringify({
          domainId,
          subDomainIds: [],
          tagIds: [],
          weeklyTimezone: "Asia/Kolkata",
          ...hours,
        }),
      },
    ),
    { params: Promise.resolve({ id: consultantProfileId }) },
  );
  return { status: res.status, body: (await res.json()) as { code?: string } };
}

it("refuses a Weekly save whose type read predates a committed switch to Custom", async () => {
  const host = await seedHost();
  sessionUser.current = { id: host.userId };
  const { domainId } = await prisma.consultantProfile.findUniqueOrThrow({
    where: { id: host.consultantProfileId },
    select: { domainId: true },
  });
  const customStart = futureAt(5, 9);
  const switchToCustom = {
    scheduleType: "CUSTOM" as const,
    availabilityWindowsCustom: [
      {
        startsAt: customStart.toISOString(),
        endsAt: new Date(customStart.getTime() + 2 * HOUR_MS).toISOString(),
      },
    ],
  };
  beforeNextTransaction.current = async () => {
    const switched = await save(
      host.consultantProfileId,
      domainId,
      switchToCustom,
    );
    expect(switched.status).toBe(200);
  };

  const weekly = await save(host.consultantProfileId, domainId, {
    scheduleType: "WEEKLY",
    availabilityWindowsWeekly: [
      {
        dayOfWeekforStartTimeInUTC: "MONDAY",
        dayOfWeekforEndTimeInUTC: "MONDAY",
        startsAt: "2026-01-05T04:30:00.000Z",
        endsAt: "2026-01-05T06:30:00.000Z",
      },
    ],
  });

  expect(weekly).toEqual({
    status: 409,
    body: expect.objectContaining({ code: "SCHEDULE_SWITCH_CONFLICT" }),
  });
  const profile = await prisma.consultantProfile.findUniqueOrThrow({
    where: { id: host.consultantProfileId },
    select: {
      scheduleType: true,
      _count: {
        select: {
          availabilityWindowsWeekly: true,
          availabilityWindowsCustom: true,
        },
      },
    },
  });
  expect(profile).toEqual({
    scheduleType: "CUSTOM",
    _count: { availabilityWindowsWeekly: 0, availabilityWindowsCustom: 1 },
  });
});
