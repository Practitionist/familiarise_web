/**
 * @jest-environment node
 */

// Invariant: the reconciler lifts only its own drift FREEZE, and only while the event its snapshot saw is still the latest.

type Event = {
  id: string;
  correlationId: string;
  category: string;
  context: Record<string, unknown>;
  createdAt: number;
};
let events: Event[] = [];
const created: Array<{ data: Record<string, unknown> }> = [];

const latestFirst = (rows: Event[]) =>
  [...rows].sort((a, b) => b.createdAt - a.createdAt);

jest.mock("../../lib/prisma", () => {
  const systemEvent = {
    findMany: async ({
      where,
    }: {
      where: { correlationId: { in: string[] } };
    }) =>
      latestFirst(
        events.filter((e) => where.correlationId.in.includes(e.correlationId)),
      ),
    findFirst: async ({ where }: { where: { correlationId: string } }) =>
      latestFirst(
        events.filter((e) => e.correlationId === where.correlationId),
      )[0] ?? null,
    create: async (args: { data: Omit<Event, "id" | "createdAt"> }) => {
      created.push(args);
      events.push({
        ...args.data,
        id: `ev_${events.length + 1}`,
        createdAt: 100 + events.length,
      });
      return {};
    },
  };
  return {
    __esModule: true,
    default: {
      systemEvent,
      $transaction: (fn: (tx: unknown) => unknown) => fn({ systemEvent }),
    },
  };
});

import {
  latestDriftFreezeIds,
  releaseReconciledWalletFreezes,
} from "@/lib/payments/wallet-freeze";

const freeze = (id: string, ba: string, at: number, source?: string) => ({
  id,
  correlationId: `wallet-freeze:${ba}`,
  category: "WALLET_FREEZE",
  context: source ? { source } : {},
  createdAt: at,
});

/** What the reconcile snapshot hands the release: its view of each account's drift freeze. */
async function snapshot(ids: string[]) {
  const seen = await latestDriftFreezeIds(
    jest.requireMock("../../lib/prisma").default,
    ids,
  );
  return ids.map((id) => ({
    billingAccountId: id,
    organizationId: "org_1",
    driftFreezeId: seen.get(id) ?? null,
  }));
}

beforeEach(() => {
  created.length = 0;
  events = [
    freeze("ev_drift", "ba_drift", 1, "reconcile-drift"),
    freeze("ev_ops", "ba_ops", 1),
  ];
});

it("lifts a drift freeze once, as SYSTEM, and never an ops freeze", async () => {
  const inSync = await snapshot(["ba_drift", "ba_ops", "ba_never"]);

  expect(await releaseReconciledWalletFreezes("rep_9", inSync)).toEqual([
    "ba_drift",
  ]);
  expect(created).toHaveLength(1);
  expect(created[0].data).toMatchObject({
    category: "WALLET_UNFREEZE",
    correlationId: "wallet-freeze:ba_drift",
    context: { unfrozenBy: "SYSTEM" },
  });
  // Replaying the same snapshot finds the freeze already lifted.
  expect(await releaseReconciledWalletFreezes("rep_9", inSync)).toEqual([]);
  expect(created).toHaveLength(1);
});

it("keeps a freeze written after the snapshot", async () => {
  const inSync = await snapshot(["ba_drift"]);
  // Ops refund-remaining freezes again after the snapshot was read.
  events.push(
    { ...freeze("ev_unfreeze", "ba_drift", 2), category: "WALLET_UNFREEZE" },
    freeze("ev_ops_later", "ba_drift", 3),
  );

  expect(await releaseReconciledWalletFreezes("rep_9", inSync)).toEqual([]);
  expect(created).toHaveLength(0);
});
