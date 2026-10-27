/** Real PostgreSQL retention/replay interleavings; only the guarded disposable CI database. */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import prisma from "../../lib/prisma";
import { assertDisposableDatabase } from "./guard";
import { pruneMessagingRetentionTables } from "../../scripts/cleanup/prune-system-job-executions";

const NOW = new Date("2026-10-23T03:26:00.000Z");
const DAY = 86_400_000;
const rows: string[] = [];

beforeAll(() => assertDisposableDatabase());
afterEach(async () => {
  await prisma.failedEmail.deleteMany({ where: { id: { in: rows } } });
  await prisma.failedEmailBatch.deleteMany({ where: { id: { in: rows } } });
  rows.length = 0;
});

async function email(days: number, status: "SENT" | "DEAD_LETTER" = "SENT") {
  const id = `retention-${randomUUID()}`;
  rows.push(id);
  const age = new Date(NOW.getTime() - days * DAY);
  return prisma.failedEmail.create({
    data: {
      id,
      recipient: "retention@example.invalid",
      subject: "Disposable database fixture",
      htmlBody: "<p>Fixture</p>",
      textBody: "Fixture",
      emailType: "TEST",
      status,
      createdAt: age,
      updatedAt: age,
    },
  });
}

it("preserves a dead letter requeued while retention waits for its row lock", async () => {
  const row = await email(91, "DEAD_LETTER");
  const operator = new Client({ connectionString: process.env.DATABASE_URL });
  await operator.connect();
  let sweep: ReturnType<typeof pruneMessagingRetentionTables> | undefined;
  try {
    await operator.query("BEGIN");
    await operator.query(
      'SELECT "id" FROM "FailedEmail" WHERE "id" = $1 FOR UPDATE',
      [row.id],
    );
    sweep = pruneMessagingRetentionTables(NOW, { limit: 1 });
    const deadline = Date.now() + 5_000;
    let blocked = false;
    while (Date.now() < deadline) {
      const result = await operator.query<{ blocked: boolean }>(`
        SELECT EXISTS (
          SELECT 1 FROM pg_locks
          WHERE NOT granted AND pid <> pg_backend_pid()
            AND pg_backend_pid() = ANY(pg_blocking_pids(pid))
        ) AS blocked
      `);
      if (result.rows[0]?.blocked) {
        blocked = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(blocked).toBe(true);
    await operator.query(
      'UPDATE "FailedEmail" SET "status" = \'PENDING\', "updatedAt" = $2 WHERE "id" = $1',
      [row.id, NOW],
    );
    await operator.query("COMMIT");
    expect((await sweep).failedEmailsPruned).toBe(0);
    expect(
      await prisma.failedEmail.findUnique({ where: { id: row.id } }),
    ).toMatchObject({ status: "PENDING", htmlBody: "<p>Fixture</p>" });
  } finally {
    await operator.query("ROLLBACK");
    await sweep?.catch(() => undefined);
    await operator.end();
  }
});

it("scrubs legacy payloads without changing the timestamp used by 30-day retention", async () => {
  const mail = await email(8);
  const id = `retention-batch-${randomUUID()}`;
  rows.push(id);
  const batch = await prisma.failedEmailBatch.create({
    data: {
      id,
      idempotencyKey: id,
      emailType: "TEST",
      status: "SENT",
      payload: [{ html: "Fixture" }],
      updatedAt: mail.updatedAt,
    },
  });
  const result = await pruneMessagingRetentionTables(NOW);
  expect(result).toMatchObject({
    failedEmailsBodyScrubbed: 1,
    failedEmailBatchesScrubbed: 1,
  });
  expect(
    await prisma.failedEmail.findUnique({ where: { id: mail.id } }),
  ).toMatchObject({
    htmlBody: "",
    textBody: null,
    sentAt: null,
    updatedAt: mail.updatedAt,
  });
  expect(
    await prisma.failedEmailBatch.findUnique({ where: { id } }),
  ).toMatchObject({ payload: [], updatedAt: batch.updatedAt });
  const later = new Date(NOW.getTime() + 23 * DAY);
  expect(await pruneMessagingRetentionTables(later)).toMatchObject({
    failedEmailsPruned: 1,
    failedEmailBatchesPruned: 1,
  });
});

it("resumes bounded pages and retains active or younger rows", async () => {
  for (let index = 0; index < 3; index++) await email(91, "DEAD_LETTER");
  const young = await email(89, "DEAD_LETTER");
  const active = await email(91, "DEAD_LETTER");
  await prisma.failedEmail.updateMany({
    where: { id: active.id },
    data: { status: "RETRY" },
  });
  expect(await pruneMessagingRetentionTables(NOW, { limit: 2 })).toMatchObject({
    failedEmailsPruned: 2,
    hasMore: true,
  });
  expect(await pruneMessagingRetentionTables(NOW, { limit: 2 })).toMatchObject({
    failedEmailsPruned: 1,
    hasMore: false,
  });
  expect(
    await prisma.failedEmail.findMany({
      where: { id: { in: rows } },
      select: { id: true },
    }),
  ).toEqual(expect.arrayContaining([{ id: young.id }, { id: active.id }]));
});
