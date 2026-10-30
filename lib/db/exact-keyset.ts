/**
 * Keyset continuation at the column's exact precision. A timestamptz holds
 * microseconds while a JS Date holds milliseconds, so a cursor cannot carry
 * the key ORDER BY used. Instead the cursor names its row, and that row's own
 * `(timestamp, id)` is read and compared in SQL as a row value.
 */

import { Prisma } from "@prisma/client";

import prisma from "@/lib/prisma";

const KEYSET_COLUMNS = {
  Appointment: "createdAt",
  Consultation: "requestedAt",
  Subscription: "requestedAt",
  Trial: "requestedAt",
} as const;

export type KeysetTable = keyof typeof KEYSET_COLUMNS;

/**
 * Rows strictly past the cursor row split in two: every whole millisecond
 * beyond the cursor's (`column < boundary` for desc, `column >= boundary` for
 * asc) plus the `ids` inside the cursor's millisecond that a row-value
 * comparison with the cursor row puts after it. A cursor row that no longer
 * exists continues past its millisecond.
 */
export interface ExactKeysetBand {
  boundary: Date;
  ids: string[];
}

export async function exactKeysetBand(
  table: KeysetTable,
  dir: Prisma.SortOrder,
  cursor: { id: string; at: Date },
): Promise<ExactKeysetBand> {
  const t = Prisma.raw(`"${table}"`);
  const col = Prisma.raw(`"${KEYSET_COLUMNS[table]}"`);
  const rows = await prisma.$queryRaw<{ start: Date; ids: string[] }[]>(
    dir === "desc"
      ? Prisma.sql`
          SELECT date_trunc('milliseconds', c.${col}) AS start,
                 ARRAY(
                   SELECT a.id FROM ${t} a
                   WHERE a.${col} >= date_trunc('milliseconds', c.${col})
                     AND (a.${col}, a.id) < (c.${col}, c.id)
                 ) AS ids
          FROM ${t} c WHERE c.id = ${cursor.id}`
      : Prisma.sql`
          SELECT date_trunc('milliseconds', c.${col}) AS start,
                 ARRAY(
                   SELECT a.id FROM ${t} a
                   WHERE a.${col} < date_trunc('milliseconds', c.${col}) + interval '1 millisecond'
                     AND (a.${col}, a.id) > (c.${col}, c.id)
                 ) AS ids
          FROM ${t} c WHERE c.id = ${cursor.id}`,
  );
  const start = rows[0]?.start ?? cursor.at;
  return {
    boundary: dir === "desc" ? start : new Date(new Date(start).getTime() + 1),
    ids: rows[0]?.ids ?? [],
  };
}
