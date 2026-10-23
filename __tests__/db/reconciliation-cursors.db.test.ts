/** Operator rollout SQL must work against physical tables in disposable PostgreSQL. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { assertDisposableDatabase } from "./guard";

it("applies cursor DDL twice using the mapped table and matching timestamp types", async () => {
  assertDisposableDatabase();
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const sql = readFileSync(
      join(process.cwd(), "prisma/sql/reconciliation-cursors.sql"),
      "utf8",
    );
    await client.query(sql);
    await client.query(sql);
    const columns = await client.query<{
      table_name: string;
      column_name: string;
      data_type: string;
    }>(`
      SELECT table_name, column_name, data_type FROM information_schema.columns
      WHERE table_schema = 'public' AND (
        (table_name IN ('Payment', 'Refund', 'WalletTopUp') AND column_name = 'lastReconciledAt')
        OR (table_name = 'organizations' AND column_name = 'lastAccrualRollupAt')
      )
    `);
    expect(columns.rows).toHaveLength(4);
    expect(
      columns.rows.every((row) => row.data_type === "timestamp with time zone"),
    ).toBe(true);
    const index = await client.query<{ name: string | null }>(
      "SELECT to_regclass('public.\"organizations_lastAccrualRollupAt_id_idx\"')::text AS name",
    );
    expect(index.rows[0]?.name).not.toBeNull();
  } finally {
    await client.end();
  }
});
