/**
 * @jest-environment node
 */

/**
 * A booking's trace reads the console audit rows of every one of its
 * sessions, including a session whose only history row the timeline hides.
 */

const SESSION = "occ-1";
const BOOKING = "8b2f6c1e-1d2a-4f3b-9c4d-5e6f7a8b9c0d";
const AT = new Date("2026-11-10T10:00:00Z");

const mockOpsFindMany = jest.fn(async (args: { where: { OR: unknown[] } }) =>
  JSON.stringify(args.where.OR).includes(`"${SESSION}"`)
    ? [
        {
          id: "ops-1",
          action: "session.set-outcome",
          targetKind: "AppointmentOccurrence",
          targetId: SESSION,
          reason: "Learner could not get in",
          actorRole: "ADMIN",
          createdAt: AT,
          actor: { name: "Olivia" },
        },
      ]
    : [],
);

jest.mock("../../lib/prisma", () => {
  const empty = {
    findMany: async () => [],
    findFirst: async () => null,
    findUnique: async () => null,
    count: async () => 0,
  };
  const models: Record<string, unknown> = {
    appointment: {
      ...empty,
      // One row answers both the trace's root read and the timeline's key read.
      findUnique: async () => ({
        id: BOOKING,
        payment: [],
        consultationId: null,
        subscriptionId: "sub-1",
        webinarId: null,
        classId: null,
        trial: null,
        occurrences: [{ id: SESSION }],
        rescheduleRequests: [],
      }),
    },
    // The session's only history row is a reason-free, actor-free self-edge,
    // which the timeline query excludes, so the database returns nothing.
    bookingStatusHistory: {
      ...empty,
      fields: { toStatus: "field:toStatus" },
    },
    opsActionLog: { findMany: (args: never) => mockOpsFindMany(args) },
  };
  return {
    __esModule: true,
    default: new Proxy(models, {
      get: (target, prop: string) => target[prop] ?? empty,
    }),
  };
});

import { readEntityTrace } from "../../lib/backoffice/entity-trace";

it("keeps a session's console audit row when its only history is a hidden self-edge", async () => {
  jest.spyOn(console, "warn").mockImplementation(() => undefined);
  const trace = await readEntityTrace({
    kind: "booking",
    id: BOOKING,
    viewer: { userId: "admin-1", role: "ADMIN", seesSystemEvents: false },
  });

  expect(mockOpsFindMany).toHaveBeenCalledTimes(1);
  expect(mockOpsFindMany.mock.calls[0][0].where.OR).toContainEqual({
    targetKind: "AppointmentOccurrence",
    targetId: { in: [SESSION] },
  });
  expect(trace?.rows.find((row) => row.key.endsWith("ops:ops-1"))?.status).toBe(
    "Console: session.set-outcome",
  );
});
