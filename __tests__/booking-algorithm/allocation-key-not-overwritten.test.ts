/**
 * The allocation idempotency key rides on the booking's one wrapper: a later
 * batch on a reused wrapper never overwrites the key an earlier batch stamped,
 * so that batch's retry still replays it; a wrapper with no key takes the new one.
 */

import "./setup";

jest.mock("../../lib/prisma", () => ({ __esModule: true, default: {} }));
jest.mock("../../lib/payments/payouts/earnings-hold", () => ({
  recomputeEarningsHold: jest.fn(async () => undefined),
}));

import { createAppointments } from "@/lib/booking/allocation/commit/create-appointments";
import type { Tx } from "@/lib/prisma";

const at = (days: number, minutes = 0) =>
  new Date(Date.UTC(2031, 2, 3 + days, 10, minutes));

function wrapperWorld(stampedKey: string | null) {
  const wrapper = {
    id: "apt-1",
    classId: "class-1",
    allocationIdempotencyKey: stampedKey,
    occurrences: [] as Record<string, unknown>[],
  };
  const updateMany = jest.fn(
    async ({
      where,
      data,
    }: {
      where: { id: string; allocationIdempotencyKey: null };
      data: { allocationIdempotencyKey: string };
    }) => {
      if (where.id !== wrapper.id || wrapper.allocationIdempotencyKey !== null)
        return { count: 0 };
      wrapper.allocationIdempotencyKey = data.allocationIdempotencyKey;
      return { count: 1 };
    },
  );
  const update = jest.fn(
    async ({
      data,
    }: {
      data: {
        allocationIdempotencyKey?: string;
        occurrences: { create: Record<string, unknown>[] };
      };
    }) => {
      if (data.allocationIdempotencyKey !== undefined)
        wrapper.allocationIdempotencyKey = data.allocationIdempotencyKey;
      wrapper.occurrences.push(
        ...data.occurrences.create.map((o, i) => ({ ...o, id: `occ-${i}` })),
      );
      return wrapper;
    },
  );
  const tx = {
    consultantProfile: { findFirst: async () => ({ id: "cp-1" }) },
    appointment: { updateMany, update },
    appointmentOccurrence: {
      aggregate: async () => ({ _max: { ordinal: 4 } }),
    },
    appointmentParticipant: {
      createMany: async () => ({ count: 0 }),
      updateMany: async () => ({ count: 0 }),
    },
  };
  return { wrapper, updateMany, update, tx: tx as unknown as Tx };
}

const allocate = (tx: Tx, key: string) =>
  createAppointments(
    tx,
    "class",
    "class-1",
    [at(9), at(9, 30)],
    "host-user",
    undefined,
    undefined,
    null,
    "apt-1",
    key,
  );

it("keeps the first batch's key when a later batch reuses the wrapper", async () => {
  const world = wrapperWorld("batch-1-key");

  await allocate(world.tx, "batch-2-key");

  expect(world.wrapper.allocationIdempotencyKey).toBe("batch-1-key");
  expect(world.update.mock.calls[0][0].data).not.toHaveProperty(
    "allocationIdempotencyKey",
  );
  expect(world.wrapper.occurrences).toHaveLength(1);
});

it("stamps the key on a reused wrapper that has none yet", async () => {
  const world = wrapperWorld(null);

  await allocate(world.tx, "batch-1-key");

  expect(world.updateMany).toHaveBeenCalledWith({
    where: { id: "apt-1", allocationIdempotencyKey: null },
    data: { allocationIdempotencyKey: "batch-1-key" },
  });
  expect(world.wrapper.allocationIdempotencyKey).toBe("batch-1-key");
});
