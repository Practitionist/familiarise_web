/**
 * @jest-environment node
 */

/** The db-migrate.yml gate and the check-migrations lint, pinned to Prisma 7.10.1's real output. */

import fs from "node:fs";
import path from "node:path";

import {
  lintMigrationSql,
  outOfOrder,
  unexpectedDiff,
} from "@/scripts/ci/check-migrations";
import { contractRefusal, judgeStatus } from "@/scripts/ci/migrate-gate";
import {
  MIGRATIONS_DIR,
  migrationFolders,
  parseSidecarSql,
} from "@/scripts/db/sidecar-objects";

const PENDING = `Datasource "db": PostgreSQL database "st1", schema "public" at "localhost:55432"

20 migrations found in prisma/migrations
Following migrations have not yet been applied:
20261109000018_analytics_views
20261109000019_org_data_export_rls

To apply migrations in development run prisma migrate dev.
To apply migrations in production run prisma migrate deploy.`;
const FAILED = `21 migrations found in prisma/migrations
Following migration have failed:
20261109000020_rehearsal_fail

During development if the failed migration(s) have not been deployed to a production database you can then fix the migration(s) and run prisma migrate dev.`;

describe("migrate status gate", () => {
  it("passes a pending-only history and names what will apply", () => {
    expect(judgeStatus(1, PENDING)).toEqual({
      ok: true,
      pending: [
        "20261109000018_analytics_views",
        "20261109000019_org_data_export_rls",
      ],
    });
    expect(
      judgeStatus(0, "20 migrations found\n\nDatabase schema is up to date!"),
    ).toEqual({ ok: true, pending: [] });
  });

  it("stops on a failed migration, an engine error or unknown output", () => {
    expect(judgeStatus(1, FAILED).ok).toBe(false);
    expect(
      judgeStatus(
        1,
        "Error: P1001: Can't reach database server at `localhost:55499`",
      ),
    ).toEqual({
      ok: false,
      reason: "P1001: Can't reach database server at `localhost:55499`",
    });
    expect(judgeStatus(1, "something new").ok).toBe(false);
  });

  it("applies a pending _contract folder only when the dispatch input names it", () => {
    const pending = ["20261201000000_add_x", "20261202000000_drop_y_contract"];
    expect(contractRefusal(pending, "")).toMatch(/need a workflow_dispatch/);
    expect(contractRefusal(pending, "20261202000000_drop_y")).toMatch(
      /not a _contract folder/,
    );
    expect(contractRefusal(pending, "20261203000000_drop_z_contract")).toMatch(
      /not a pending migration/,
    );
    expect(contractRefusal(pending, "20261202000000_drop_y_contract")).toBe(
      null,
    );
    expect(contractRefusal(["20261201000000_add_x"], "")).toBe(null);
  });
});

describe("migration history lint", () => {
  it("accepts every committed migration", () => {
    const problems = migrationFolders().flatMap((folder) =>
      lintMigrationSql(
        fs.readFileSync(
          path.join(MIGRATIONS_DIR, folder, "migration.sql"),
          "utf8",
        ),
      ).map((p) => `${folder}: ${p}`),
    );
    expect(problems).toEqual([]);
  });

  it("refuses unwrapped files, leaking SETs and mixed CONCURRENTLY", () => {
    expect(lintMigrationSql("ALTER TABLE a ADD COLUMN b int;")).toContain(
      "does not start with BEGIN;",
    );
    expect(
      lintMigrationSql(
        "BEGIN;\nSET LOCAL lock_timeout = '3s';\nSET statement_timeout = '1s';\nCOMMIT;",
      ),
    ).toEqual([
      "uses a session-level SET or RESET, which leaks into later migrations; use SET LOCAL",
    ]);
    expect(
      lintMigrationSql('CREATE INDEX CONCURRENTLY "i" ON "t" ("c");'),
    ).toEqual([]);
    expect(
      lintMigrationSql(
        'BEGIN;\nCREATE INDEX CONCURRENTLY "i" ON "t" ("c");\nCOMMIT;',
      ),
    ).toHaveLength(1);
  });

  it("orders new folders after the base and filters only schema-inexpressible drops", () => {
    expect(
      outOfOrder(["0_baseline", "20261109000019_x"], ["20261109000005_y"]),
    ).toEqual(["20261109000005_y"]);
    expect(outOfOrder([], ["0_baseline"])).toEqual([]);
    const plan = `-- DropIndex\nDROP INDEX "owned_key";\n\n-- DropIndex\nDROP INDEX "other_key";`;
    expect(unexpectedDiff(plan, new Set(["owned_key"]))).toEqual([
      'DROP INDEX "other_key"',
    ]);
  });

  it("replays DROP and RENAME so the inventory is what the history leaves", () => {
    const sql = `ALTER TABLE "t" DROP CONSTRAINT IF EXISTS "c", ADD CONSTRAINT "c" CHECK (x > 0);
CREATE UNIQUE INDEX "i" ON "t" ("x");
DROP INDEX "i";
CREATE INDEX "j" ON "t" ("x");
ALTER INDEX "j" RENAME TO "k";`;
    expect(
      parseSidecarSql(sql, "f")
        .map((o) => `${o.kind}:${o.name}`)
        .sort(),
    ).toEqual(["constraint:c", "index:k"]);
  });
});
