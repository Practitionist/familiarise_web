/**
 * The one writer of EarningStatus.HELD. An earning is HELD iff it carries at
 * least one active EarningsHold; each owner (a dispute, a ban, an operator, an
 * unpaid overage) places and releases only its own hold, so releasing one
 * never frees money another owner still holds.
 *
 * The first hold stores the row's prior status in `preHoldStatus`; the last
 * release restores it. Both paths write the earning row before touching hold
 * rows, so a place and a release on the same earning serialize on its row lock.
 */

import {
  EarningStatus,
  type EarningsHoldReason,
  type Prisma,
} from "@prisma/client";

import type { Tx } from "@/lib/prisma";
import { assertEarningStatusTransitionLegal } from "./earning-status";

export type EarningsSide = "consultant" | "org";

export type EarningsHoldDb = Pick<
  Tx,
  "consultantEarnings" | "organizationEarnings" | "earningsHold"
>;

/** Statuses a hold may freeze; a HELD row only gains another hold. */
export const HOLDABLE_EARNING_STATUSES: EarningStatus[] = [
  EarningStatus.PENDING,
  EarningStatus.PENDING_TRUST,
  EarningStatus.READY,
];

export class EarningsHoldRaceError extends Error {
  constructor(side: EarningsSide, ids: string[]) {
    super(
      `${side} earnings ${ids.join(", ")} changed status while a hold was being placed`,
    );
    this.name = "EarningsHoldRaceError";
  }
}

interface HeldRow {
  id: string;
  status: EarningStatus;
  preHoldStatus: EarningStatus | null;
  holdUntil: Date | null;
}

interface StatusWhere {
  ids: string[];
  status: EarningStatus;
  preHoldStatus?: EarningStatus | null;
  holdUntilLte?: Date;
}

interface Rail {
  read(ids: string[]): Promise<HeldRow[]>;
  cas(
    where: StatusWhere,
    data: { status: EarningStatus; preHoldStatus?: EarningStatus | null },
  ): Promise<number>;
  holdWhere(ids: string[]): Prisma.EarningsHoldWhereInput;
  holdRow(id: string):
    | { consultantEarningsId: string }
    | {
        organizationEarningsId: string;
      };
  idOf(hold: {
    consultantEarningsId: string | null;
    organizationEarningsId: string | null;
  }): string | null;
}

const HELD_ROW_SELECT = {
  id: true,
  status: true,
  preHoldStatus: true,
  holdUntil: true,
} as const;

function statusWhere(w: StatusWhere) {
  return {
    id: { in: w.ids },
    status: w.status,
    ...(w.preHoldStatus !== undefined && { preHoldStatus: w.preHoldStatus }),
    ...(w.holdUntilLte && { holdUntil: { lte: w.holdUntilLte } }),
  };
}

function railOf(db: EarningsHoldDb, side: EarningsSide): Rail {
  if (side === "consultant") {
    return {
      read: (ids) =>
        db.consultantEarnings.findMany({
          where: { id: { in: ids } },
          select: HELD_ROW_SELECT,
        }),
      cas: async (where, data) =>
        (
          await db.consultantEarnings.updateMany({
            where: statusWhere(where),
            data,
          })
        ).count,
      holdWhere: (ids) => ({ consultantEarningsId: { in: ids } }),
      holdRow: (id) => ({ consultantEarningsId: id }),
      idOf: (h) => h.consultantEarningsId,
    };
  }
  return {
    read: (ids) =>
      db.organizationEarnings.findMany({
        where: { id: { in: ids } },
        select: HELD_ROW_SELECT,
      }),
    cas: async (where, data) =>
      (
        await db.organizationEarnings.updateMany({
          where: statusWhere(where),
          data,
        })
      ).count,
    holdWhere: (ids) => ({ organizationEarningsId: { in: ids } }),
    holdRow: (id) => ({ organizationEarningsId: id }),
    idOf: (h) => h.organizationEarningsId,
  };
}

export interface HoldSpec {
  reason: EarningsHoldReason;
  sourceRef: string;
  note?: string | null;
}

/**
 * Places `hold` on every holdable earning in `ids` and answers the ids that
 * gained it. Idempotent per (earning, reason, sourceRef); PAID, BATCHED and
 * REFUNDED rows are skipped. Throws EarningsHoldRaceError when a row keeps
 * moving under the CAS.
 */
export async function placeEarningsHolds(
  db: EarningsHoldDb,
  side: EarningsSide,
  ids: string[],
  hold: HoldSpec,
): Promise<string[]> {
  if (ids.length === 0) return [];
  const rail = railOf(db, side);
  const already = await db.earningsHold.findMany({
    where: {
      ...rail.holdWhere(ids),
      reason: hold.reason,
      sourceRef: hold.sourceRef,
      releasedAt: null,
    },
    select: { consultantEarningsId: true, organizationEarningsId: true },
  });
  const skip = new Set(already.map(rail.idOf));
  let pending = [...new Set(ids)].filter((id) => !skip.has(id));
  const placed: string[] = [];

  for (let attempt = 0; attempt < 2 && pending.length > 0; attempt++) {
    const rows = await rail.read(pending);
    const byStatus = new Map<EarningStatus, string[]>();
    for (const row of rows) {
      if (
        row.status !== EarningStatus.HELD &&
        !HOLDABLE_EARNING_STATUSES.includes(row.status)
      ) {
        continue;
      }
      assertEarningStatusTransitionLegal(
        row.id,
        row.status,
        EarningStatus.HELD,
      );
      byStatus.set(row.status, [...(byStatus.get(row.status) ?? []), row.id]);
    }
    const moved = new Set<string>();
    for (const [status, group] of byStatus) {
      const count = await rail.cas(
        { ids: group, status },
        status === EarningStatus.HELD
          ? { status }
          : { status: EarningStatus.HELD, preHoldStatus: status },
      );
      // A short count means a row moved between the read and the CAS; the
      // group is re-read on the next attempt to find which one.
      if (count === group.length) group.forEach((id) => moved.add(id));
    }
    placed.push(...moved);
    pending = [...byStatus.values()].flat().filter((id) => !moved.has(id));
  }
  if (pending.length > 0) throw new EarningsHoldRaceError(side, pending);

  if (placed.length > 0) {
    await db.earningsHold.createMany({
      data: placed.map((id) => ({
        ...rail.holdRow(id),
        reason: hold.reason,
        sourceRef: hold.sourceRef,
        note: hold.note ?? null,
      })),
    });
  }
  return placed;
}

export interface ReleaseMatch {
  reasons: EarningsHoldReason[];
  /** Omitted: every active hold of those reasons. */
  sourceRef?: string;
}

export interface ReleaseOutcome {
  /** Earnings whose matching holds were released. */
  released: string[];
  /** Earnings that left HELD, by the status each returned to. */
  restored: Map<string, EarningStatus>;
}

/**
 * Releases the matching active holds on `ids`. An earning left without any
 * active hold returns to its `preHoldStatus`; a row with none recorded matures
 * to READY once `holdUntil` has passed, else PENDING.
 */
export async function releaseEarningsHolds(
  db: EarningsHoldDb,
  side: EarningsSide,
  ids: string[],
  match: ReleaseMatch,
  opts: { releasedById?: string | null; now?: Date } = {},
): Promise<ReleaseOutcome> {
  const restored = new Map<string, EarningStatus>();
  if (ids.length === 0) return { released: [], restored };
  const rail = railOf(db, side);
  const now = opts.now ?? new Date();

  // Row lock first, so a concurrent place cannot land between the count and the restore.
  await rail.cas(
    { ids, status: EarningStatus.HELD },
    { status: EarningStatus.HELD },
  );

  const matching = await db.earningsHold.findMany({
    where: {
      ...rail.holdWhere(ids),
      reason: { in: match.reasons },
      ...(match.sourceRef !== undefined && { sourceRef: match.sourceRef }),
      releasedAt: null,
    },
    select: {
      id: true,
      consultantEarningsId: true,
      organizationEarningsId: true,
    },
  });
  if (matching.length === 0) return { released: [], restored };
  await db.earningsHold.updateMany({
    where: { id: { in: matching.map((h) => h.id) }, releasedAt: null },
    data: { releasedAt: now, releasedById: opts.releasedById ?? null },
  });
  const released = [
    ...new Set(
      matching.map(rail.idOf).filter((id): id is string => id !== null),
    ),
  ];

  const stillHeld = await db.earningsHold.findMany({
    where: { ...rail.holdWhere(released), releasedAt: null },
    select: { consultantEarningsId: true, organizationEarningsId: true },
  });
  const blocked = new Set(stillHeld.map(rail.idOf));
  const free = released.filter((id) => !blocked.has(id));
  if (free.length === 0) return { released, restored };

  const rows = (await rail.read(free)).filter(
    (r) => r.status === EarningStatus.HELD,
  );
  const groups = new Map<string, { where: StatusWhere; to: EarningStatus }>();
  for (const row of rows) {
    const matured = Boolean(row.holdUntil && row.holdUntil <= now);
    const to =
      row.preHoldStatus ??
      (matured ? EarningStatus.READY : EarningStatus.PENDING);
    assertEarningStatusTransitionLegal(row.id, EarningStatus.HELD, to);
    const key = `${row.preHoldStatus ?? "none"}:${to}`;
    const group = groups.get(key) ?? {
      where: {
        ids: [],
        status: EarningStatus.HELD,
        preHoldStatus: row.preHoldStatus,
        ...(row.preHoldStatus === null && matured && { holdUntilLte: now }),
      },
      to,
    };
    group.where.ids.push(row.id);
    groups.set(key, group);
  }
  for (const { where, to } of groups.values()) {
    const count = await rail.cas(where, { status: to, preHoldStatus: null });
    if (count === where.ids.length) {
      where.ids.forEach((id) => restored.set(id, to));
    }
  }
  return { released, restored };
}
