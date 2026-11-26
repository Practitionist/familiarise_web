/**
 * An in-memory world behind the Prisma surface the Razorpay webhook route,
 * its event log, the dispatch switch and the payment, refund and dispute
 * handlers touch. The `where` matcher honours the predicates the money paths
 * repeat in their CAS writes, so a stub that ignored them cannot pass.
 */

import { Prisma } from "@prisma/client";
import { createEarningsHoldStore } from "./earnings-hold-store";
import { applyData, matchesWhere, type Row, type Where } from "./mem-db";

export type { Row };

export const world = {
  events: new Map<string, Row>(),
  payments: new Map<string, Row>(),
  refunds: [] as Row[],
  disputes: [] as Row[],
  transactions: 0,
};
export const holdStore = createEarningsHoldStore<
  Row & ReturnType<typeof earning>
>();

export function earning(id: string) {
  return {
    id,
    paymentId: "pay-row-1",
    status: "READY" as never,
    preHoldStatus: null,
    holdUntil: null,
  };
}

function table(rows: () => Row[]) {
  return {
    findFirst: jest.fn(async (args: { where?: Where }) => {
      const hit = rows().find((r) => matchesWhere(r, args.where));
      return hit ? { ...hit } : null;
    }),
    updateMany: jest.fn(async (args: { where?: Where; data: Row }) => {
      let count = 0;
      for (const r of rows()) {
        if (!matchesWhere(r, args.where)) continue;
        applyData(r, args.data);
        count++;
      }
      return { count };
    }),
  };
}

export const paymentApi = {
  ...table(() => [...world.payments.values()]),
  findUnique: jest.fn(async (args: { where: Where; include?: unknown }) => {
    const hit = [...world.payments.values()].find((r) =>
      matchesWhere(r, args.where),
    );
    if (!hit) return null;
    return args.include
      ? { ...hit, user: { email: "buyer@example.com", name: "Buyer" } }
      : { ...hit };
  }),
  update: jest.fn(async (args: { where: Where; data: Row }) => {
    const hit = [...world.payments.values()].find((r) =>
      matchesWhere(r, args.where),
    );
    if (!hit) throw new Error("Record to update not found");
    applyData(hit, args.data);
    return { ...hit };
  }),
};

export const refundApi = {
  ...table(() => world.refunds),
  findUnique: jest.fn(async (args: { where: Where }) => {
    const hit = world.refunds.find((r) => matchesWhere(r, args.where));
    return hit ? { ...hit } : null;
  }),
  create: jest.fn(async (args: { data: Row }) => {
    const row = { id: `rf-row-${world.refunds.length + 1}`, ...args.data };
    world.refunds.push(row);
    return { id: row.id };
  }),
};

export const disputeApi = {
  updateMany: jest.fn(async (args: { where?: Where; data: Row }) => {
    let count = 0;
    for (const r of world.disputes) {
      if (!matchesWhere(r, args.where)) continue;
      applyData(r, args.data);
      count++;
    }
    return { count };
  }),
  findUnique: jest.fn(async (args: { where: Where }) => {
    const hit = world.disputes.find((r) => matchesWhere(r, args.where));
    return hit
      ? {
          ...hit,
          payment: { id: hit.paymentId, amount: 50_000 },
        }
      : null;
  }),
  create: jest.fn(async (args: { data: Row }) => {
    const row = { id: `dsp-row-${world.disputes.length + 1}`, ...args.data };
    world.disputes.push(row);
    return { ...row };
  }),
};

const noPayouts = { updateMany: jest.fn(async () => ({ count: 0 })) };
const txStub = {
  payment: paymentApi,
  refund: refundApi,
  dispute: disputeApi,
  consultantEarnings: holdStore.db.consultantEarnings,
  organizationEarnings: holdStore.db.organizationEarnings,
  earningsHold: holdStore.db.earningsHold,
  consultantPayout: noPayouts,
  organizationPayout: noPayouts,
};

/** Deep-copies every collection the tx stub writes; the returned fn restores them in place. */
function snapshotTxState(): () => void {
  const payments = structuredClone([...world.payments.entries()]);
  const arrays: Array<[Row[], Row[]]> = [
    world.refunds,
    world.disputes,
    holdStore.consultant,
    holdStore.org,
    holdStore.holds,
  ].map((rows) => [rows as Row[], structuredClone(rows as Row[])]);
  return () => {
    world.payments.clear();
    for (const [k, v] of payments) world.payments.set(k, structuredClone(v));
    for (const [rows, copy] of arrays) rows.splice(0, rows.length, ...copy);
  };
}

export const prismaStub = {
  user: { findFirst: async () => ({ id: "u-health" }) },
  payment: paymentApi,
  // The capture router's other rails: this world holds booking payments only.
  recordingPurchase: { findUnique: async () => null },
  digitalProductPurchase: { findUnique: async () => null },
  organizationInvoice: { findFirst: async () => null },
  walletTopUp: { findMany: async () => [] },
  refund: refundApi,
  webhookEvent: {
    findUnique: async (args: { where: { eventId: string } }) => {
      const hit = world.events.get(args.where.eventId);
      return hit ? { ...hit } : null;
    },
    create: async (args: { data: Row }) => {
      if (world.events.has(String(args.data.eventId))) {
        throw new Prisma.PrismaClientKnownRequestError(
          "Unique constraint failed on the fields: (`eventId`)",
          {
            code: "P2002",
            clientVersion: Prisma.prismaVersion.client,
            meta: { target: ["eventId"] },
          },
        );
      }
      const row = {
        id: `evt-row-${world.events.size + 1}`,
        processed: false,
        error: null,
        claimedAt: null,
        receivedAt: new Date(),
        deferCount: 0,
        ...args.data,
      };
      world.events.set(String(args.data.eventId), row);
      return { ...row };
    },
    updateMany: async (args: { where: Where; data: Row }) => {
      let count = 0;
      for (const r of world.events.values()) {
        if (!matchesWhere(r, args.where)) continue;
        applyData(r, args.data);
        count++;
      }
      return { count };
    },
    update: async (args: { where: { eventId: string }; data: Row }) => {
      const r = world.events.get(args.where.eventId);
      if (!r) throw new Error("Record to update not found");
      applyData(r, args.data);
      return r;
    },
  },
  $transaction: async (fn: (tx: typeof txStub) => Promise<unknown>) => {
    world.transactions++;
    const restore = snapshotTxState();
    try {
      return await fn(txStub);
    } catch (err) {
      restore();
      throw err;
    }
  },
};
