/**
 * An in-memory double of the three tables lib/payments/payouts/earnings-holds.ts
 * reads and writes, so a suite can drive the real hold helper and assert rows.
 * The `where` matcher understands the shapes the money paths issue: equality,
 * `in` / `notIn` / `not` / `lte` / `gte`, `OR`, a to-one relation filter, and
 * `holds: { some }`.
 */

import type { EarningStatus, EarningsHoldReason } from "@prisma/client";

/** The columns the hold helper reads; a suite may widen the row type. */
export interface FakeEarning {
  id: string;
  paymentId: string;
  status: EarningStatus;
  preHoldStatus?: EarningStatus | null;
  holdUntil?: Date | null;
}

export interface FakeHold {
  id: string;
  consultantEarningsId: string | null;
  organizationEarningsId: string | null;
  reason: EarningsHoldReason;
  sourceRef: string;
  placedAt: Date;
  releasedAt: Date | null;
  releasedById: string | null;
  note: string | null;
}

type Where = Record<string, unknown>;

const OPS = ["in", "notIn", "not", "lte", "gte", "lt", "gt", "startsWith"];

function isOp(v: unknown): v is Record<string, unknown> {
  return (
    !!v &&
    typeof v === "object" &&
    !(v instanceof Date) &&
    Object.keys(v).some((k) => OPS.includes(k))
  );
}

function matchValue(actual: unknown, filter: unknown): boolean {
  if (!isOp(filter)) {
    if (filter instanceof Date && actual instanceof Date) {
      return filter.getTime() === actual.getTime();
    }
    return actual === filter;
  }
  const f = filter;
  if ("in" in f && !(f.in as unknown[]).includes(actual)) return false;
  if ("notIn" in f && (f.notIn as unknown[]).includes(actual)) return false;
  if ("not" in f && actual === f.not) return false;
  if (
    "startsWith" in f &&
    !(typeof actual === "string" && actual.startsWith(String(f.startsWith)))
  )
    return false;
  const t = actual instanceof Date ? actual.getTime() : (actual as number);
  const n = (x: unknown) => (x instanceof Date ? x.getTime() : (x as number));
  if ("lte" in f && (actual === null || actual === undefined || t > n(f.lte)))
    return false;
  if ("gte" in f && (actual === null || actual === undefined || t < n(f.gte)))
    return false;
  if ("lt" in f && (actual === null || actual === undefined || t >= n(f.lt)))
    return false;
  if ("gt" in f && (actual === null || actual === undefined || t <= n(f.gt)))
    return false;
  return true;
}

export function createEarningsHoldStore<
  C extends FakeEarning = FakeEarning,
  O extends FakeEarning = FakeEarning,
>() {
  const consultant: C[] = [];
  const org: O[] = [];
  const holds: FakeHold[] = [];
  let seq = 0;

  function matches(
    target: object,
    where: Where | undefined,
    fk?: "consultantEarningsId" | "organizationEarningsId",
  ): boolean {
    if (!where) return true;
    const row = target as Record<string, unknown>;
    for (const [key, filter] of Object.entries(where)) {
      if (filter === undefined) continue;
      if (key === "OR") {
        if (!(filter as Where[]).some((w) => matches(row, w, fk))) return false;
        continue;
      }
      if (key === "NOT") {
        if (matches(row, filter as Where, fk)) return false;
        continue;
      }
      if (key === "holds" && fk) {
        const some = (filter as { some: Where }).some;
        const own = holds.filter((h) => h[fk] === row.id);
        if (!own.some((h) => matches(h, some))) return false;
        continue;
      }
      const actual = row[key];
      if (
        filter &&
        typeof filter === "object" &&
        !isOp(filter) &&
        !(filter instanceof Date)
      ) {
        if (!actual || !matches(actual, filter as Where)) return false;
        continue;
      }
      if (!matchValue(actual, filter)) return false;
    }
    return true;
  }

  const pick = (row: object, select?: Record<string, unknown>) => {
    if (!select) return { ...row };
    const src = row as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(select)) out[k] = src[k];
    return out;
  };

  function earningsTable(
    rows: FakeEarning[],
    fk: "consultantEarningsId" | "organizationEarningsId",
  ) {
    return {
      findMany: jest.fn(async (args: { where?: Where; select?: Where } = {}) =>
        rows
          .filter((r) => matches(r, args.where, fk))
          .map((r) => pick(r, args.select)),
      ),
      findUnique: jest.fn(
        async (args: { where: { id: string }; select?: Where }) => {
          const r = rows.find((x) => x.id === args.where.id);
          return r ? pick(r, args.select) : null;
        },
      ),
      updateMany: jest.fn(async (args: { where?: Where; data: Where }) => {
        let count = 0;
        for (const r of rows) {
          if (!matches(r, args.where, fk)) continue;
          Object.assign(r, args.data);
          count++;
        }
        return { count };
      }),
    };
  }

  const earningsHold = {
    findMany: jest.fn(async (args: { where?: Where; select?: Where } = {}) =>
      holds
        .filter((h) => matches(h, args.where))
        .map((h) => pick(h, args.select)),
    ),
    createMany: jest.fn(async (args: { data: Partial<FakeHold>[] }) => {
      for (const d of args.data) {
        holds.push({
          id: `hold_${++seq}`,
          consultantEarningsId: d.consultantEarningsId ?? null,
          organizationEarningsId: d.organizationEarningsId ?? null,
          reason: d.reason as EarningsHoldReason,
          sourceRef: d.sourceRef as string,
          placedAt: new Date(),
          releasedAt: null,
          releasedById: null,
          note: d.note ?? null,
        });
      }
      return { count: args.data.length };
    }),
    updateMany: jest.fn(
      async (args: { where?: Where; data: Partial<FakeHold> }) => {
        let count = 0;
        for (const h of holds) {
          if (!matches(h, args.where)) continue;
          Object.assign(h, args.data);
          count++;
        }
        return { count };
      },
    ),
  };

  return {
    consultant,
    org,
    holds,
    db: {
      consultantEarnings: earningsTable(consultant, "consultantEarningsId"),
      organizationEarnings: earningsTable(org, "organizationEarningsId"),
      earningsHold,
    },
    activeReasons(id: string): EarningsHoldReason[] {
      return holds
        .filter(
          (h) =>
            (h.consultantEarningsId === id ||
              h.organizationEarningsId === id) &&
            h.releasedAt === null,
        )
        .map((h) => h.reason);
    },
  };
}
