/** Transaction races run only against the disposable Postgres database in CI. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "pg";

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString)
    throw new Error("The isolated CI database is required");
  const target = new URL(connectionString);
  if (
    process.env.CI !== "true" ||
    !["localhost", "127.0.0.1"].includes(target.hostname) ||
    target.pathname !== "/ci"
  )
    throw new Error(
      "Support races may run only against the disposable localhost /ci database",
    );
  const db = new Client({ connectionString });
  await db.connect();
  const actorId = randomUUID();
  const caseId = randomUUID();
  try {
    await db.query(
      'INSERT INTO "User" (id, name, email, "updatedAt") VALUES ($1, $2, $3, now())',
      [actorId, "CI participant", `${actorId}@example.invalid`],
    );
    await db.query(
      'INSERT INTO "SupportCase" (id, "referenceNumber", title, description, category, "requesterUserId", "submitterUserId", "updatedAt") VALUES ($1, $2, $3, $4, $5, $6, $6, $7)',
      [
        caseId,
        `CI-${caseId.slice(0, 12)}`,
        "CI race",
        "Isolated test",
        "GENERAL",
        actorId,
        new Date("2020-01-01"),
      ],
    );
    const send = async () => {
      const client = new Client({ connectionString });
      await client.connect();
      try {
        await client.query("BEGIN");
        const sequence = await client.query<{ messageSeq: number }>(
          'UPDATE "SupportCase" SET "messageSeq" = "messageSeq" + 1 WHERE id = $1 RETURNING "messageSeq"',
          [caseId],
        );
        await client.query(
          'INSERT INTO "SupportCaseMessage" (id, "caseId", seq, sender, body, "clientTurnId", "authorUserId") VALUES ($1, $2, $3, $4, $5, $6, $7)',
          [
            randomUUID(),
            caseId,
            sequence.rows[0].messageSeq,
            "USER",
            "One retryable message",
            "same-browser-turn",
            actorId,
          ],
        );
        await client.query("COMMIT");
        return true;
      } catch (error) {
        await client.query("ROLLBACK");
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "23505"
        )
          return false;
        throw error;
      } finally {
        await client.end();
      }
    };
    const submissions = await Promise.all([send(), send()]);
    assert.equal(
      submissions.filter(Boolean).length,
      1,
      "Duplicate client turns must have one committed writer",
    );
    const messages = await db.query<{ count: number; highest: number }>(
      'SELECT count(*)::integer AS count, max(seq) AS highest FROM "SupportCaseMessage" WHERE "caseId" = $1',
      [caseId],
    );
    assert.deepEqual(
      messages.rows[0],
      { count: 1, highest: 1 },
      "A uniqueness loser must roll back its sequence allocation",
    );
    const staleUpdates = await Promise.all(
      ["IN_PROGRESS", "ESCALATED"].map(async (status) => {
        const client = new Client({ connectionString });
        await client.connect();
        try {
          return (
            await client.query(
              'UPDATE "SupportCase" SET status = $1::"SupportCaseStatus", "updatedAt" = now() WHERE id = $2 AND "updatedAt" = $3',
              [status, caseId, new Date("2020-01-01")],
            )
          ).rowCount;
        } finally {
          await client.end();
        }
      }),
    );
    assert.equal(
      staleUpdates.reduce((sum, count) => sum + (count ?? 0), 0),
      1,
      "Stale metadata changes must not overwrite each other",
    );
    const requestId = randomUUID();
    await db.query(
      'INSERT INTO "SupportCaseEvidenceRequest" (id, "caseId", "recipientUserId", "requestedById", "clientActionId", prompt, "dueAt") VALUES ($1, $2, $3, $3, $4, $5, now() + interval \'48 hours\')',
      [
        requestId,
        caseId,
        actorId,
        randomUUID(),
        "Please provide the service record",
      ],
    );
    const responseRace = await Promise.all(
      ["response", "cancel"].map(async (action) => {
        const client = new Client({ connectionString });
        await client.connect();
        try {
          return (
            await client.query(
              action === "response"
                ? 'UPDATE "SupportCaseEvidenceRequest" SET "responseBody" = $1, "respondedAt" = now() WHERE id = $2 AND "respondedAt" IS NULL AND "cancelledAt" IS NULL'
                : 'UPDATE "SupportCaseEvidenceRequest" SET "responseBody" = $1, "cancelledAt" = now() WHERE id = $2 AND "respondedAt" IS NULL AND "cancelledAt" IS NULL',
              [action === "response" ? "Evidence" : null, requestId],
            )
          ).rowCount;
        } finally {
          await client.end();
        }
      }),
    );
    assert.equal(
      responseRace.reduce((sum, count) => sum + (count ?? 0), 0),
      1,
      "Cancellation and submission must have one winner",
    );
    const decisionId = randomUUID();
    await db.query(
      'INSERT INTO "SupportCaseDecision" (id, "caseId", "decidedById", "clientActionId", outcome, explanation, "appealUntil") VALUES ($1, $2, $3, $4, $5, $6, now() + interval \'7 days\')',
      [
        decisionId,
        caseId,
        actorId,
        randomUUID(),
        "NO_REMEDY",
        "Recorded decision",
      ],
    );
    await assert.rejects(
      db.query(
        'UPDATE "SupportCaseDecision" SET explanation = $1 WHERE id = $2',
        ["Overwritten", decisionId],
      ),
      /immutable/,
    );
    console.log(
      "Support transaction checks passed: duplicate reply, stale metadata, evidence cancellation and immutable decisions.",
    );
  } finally {
    await db.end();
  }
}
void main().catch((error: unknown) => {
  console.error(
    error instanceof Error ? error.message : "Support transaction check failed",
  );
  process.exitCode = 1;
});
