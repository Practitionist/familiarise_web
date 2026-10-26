/**
 * @jest-environment node
 */

// Invariant: a reconcile snapshot that finds a frozen wallet back in sync lifts the freeze once, as SYSTEM, through the CAS unfreeze.

type Event = { correlationId: string; category: string; createdAt: number };
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
    create: async (args: { data: Event & Record<string, unknown> }) => {
      created.push(args);
      events.push({ ...args.data, createdAt: Date.now() + created.length });
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

import { releaseReconciledWalletFreezes } from "@/lib/payments/wallet-freeze";

const at = (correlationId: string, category: string, createdAt: number) => ({
  correlationId,
  category,
  createdAt,
});

beforeEach(() => {
  created.length = 0;
  events = [
    at("wallet-freeze:ba_frozen", "WALLET_FREEZE", 1),
    at("wallet-freeze:ba_cleared", "WALLET_FREEZE", 1),
    at("wallet-freeze:ba_cleared", "WALLET_UNFREEZE", 2),
  ];
});

it("unfreezes only the in-sync accounts still frozen, as SYSTEM, and only once", async () => {
  const inSync = ["ba_frozen", "ba_cleared", "ba_never"].map((id) => ({
    billingAccountId: id,
    organizationId: "org_1",
  }));

  expect(await releaseReconciledWalletFreezes("rep_9", inSync)).toEqual([
    "ba_frozen",
  ]);
  expect(created).toHaveLength(1);
  expect(created[0].data).toMatchObject({
    category: "WALLET_UNFREEZE",
    correlationId: "wallet-freeze:ba_frozen",
    context: { unfrozenBy: "SYSTEM" },
  });

  expect(await releaseReconciledWalletFreezes("rep_10", inSync)).toEqual([]);
  expect(created).toHaveLength(1);
});
