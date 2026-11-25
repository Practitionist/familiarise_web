/**
 * Shared double for the earnings-release suites: a lock that just runs, a
 * Prisma client of two in-memory earnings tables and the declared incidents
 * the release reads, and the seed of one consultant row and one organisation
 * row over a payment.
 */

import { memTable, type Row } from "./mem-db";

export const PAST = new Date("2026-06-01T00:00:00.000Z");

export type EarningsTable = ReturnType<typeof memTable>;

export function cronLockModule() {
  return {
    __esModule: true,
    withCronLock: jest.fn(
      async (_key: string, _opts: unknown, fn: () => Promise<unknown>) => fn(),
    ),
  };
}

export function earningsPrismaModule() {
  const client = {
    consultantEarnings: memTable([], "ce"),
    organizationEarnings: memTable([], "oe"),
    platformIncident: memTable([], "inc"),
  };
  return {
    __esModule: true,
    default: {
      ...client,
      $transaction: jest.fn(async (fn: (tx: unknown) => unknown) => fn(client)),
      $disconnect: jest.fn(),
    },
  };
}

export function seedEarnings(
  tables: {
    consultantEarnings: EarningsTable;
    organizationEarnings: EarningsTable;
  },
  status: "PENDING" | "PENDING_TRUST",
  payment: Row,
) {
  const { consultantEarnings, organizationEarnings } = tables;
  consultantEarnings.rows.splice(0, consultantEarnings.rows.length, {
    id: "ce_1",
    status,
    holdUntil: PAST,
    consultantSharePaise: 80_000,
    consultantProfile: { user: { name: "C", email: "c@x" } },
    payment,
  });
  organizationEarnings.rows.splice(0, organizationEarnings.rows.length, {
    id: "oe_1",
    status,
    holdUntil: PAST,
    orgSharePaise: 10_000,
    organization: { name: "Host org" },
    payment,
  });
}
