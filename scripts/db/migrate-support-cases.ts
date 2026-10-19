/** Restartable legacy support drain. Requires a dedicated target URL; dry-run is read-only. */
import { createHash } from "node:crypto";
import { Client } from "pg";
import { z } from "zod";

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
const json: z.ZodType<Json> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(json),
    z.record(json),
  ]),
);
const stamp = z.coerce.date();
const nullableStamp = stamp.nullable().default(null);
const nullableText = z.string().nullable().default(null);
const status = z.enum([
  "OPEN",
  "IN_PROGRESS",
  "ESCALATED",
  "ON_HOLD",
  "RESOLVED",
  "CLOSED",
]);
const channel = z.enum(["SELF_SERVE", "AI", "HUMAN"]);
const priority = z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]);
const sender = z.enum(["USER", "BOT", "AGENT", "SYSTEM"]);
const eventKind = z.enum([
  "CREATED",
  "STATUS_CHANGED",
  "PRIORITY_CHANGED",
  "ASSIGNED",
  "UNASSIGNED",
  "VISIBILITY_CHANGED",
  "LINKED_PROBLEM",
  "DUPLICATE_CLOSED",
  "REOPENED",
  "AUTO_CLOSED",
  "CSAT_RATED",
]);
const ticketSchema = z.object({
  id: z.string(),
  userId: z.string(),
  title: z.string(),
  description: z.string(),
  referenceNumber: nullableText,
  organizationId: nullableText,
  category: nullableText,
  issueType: nullableText,
  priority,
  status,
  assignedToId: nullableText,
  consultationId: nullableText,
  subscriptionId: nullableText,
  paymentId: nullableText,
  refundId: nullableText,
  ackDueAt: nullableStamp,
  acknowledgedAt: nullableStamp,
  resolutionDueAt: nullableStamp,
  resolvedAt: nullableStamp,
  closedAt: nullableStamp,
  firstAgentReplyAt: nullableStamp,
  awaitingUserSince: nullableStamp,
  pausedSeconds: z.number().int().nonnegative().default(0),
  lastMessageAt: nullableStamp,
  createdAt: stamp,
  updatedAt: stamp,
});
const threadSchema = z.object({
  id: z.string(),
  userId: z.string(),
  appointmentId: z.string(),
  organizationId: nullableText,
  supportTicketId: nullableText,
  category: z.string(),
  status,
  activeChannel: channel,
  currentNodeId: nullableText,
  resolvedAt: nullableStamp,
  lastMessageAt: nullableStamp,
  createdAt: stamp,
  updatedAt: stamp,
});
const responseSchema = z.object({
  id: z.string(),
  userId: z.string(),
  message: z.string(),
  isInternal: z.boolean(),
  createdAt: stamp,
});
const messageSchema = z.object({
  id: z.string(),
  sender,
  body: z.string(),
  metadata: json.nullable().default(null),
  seq: z.number().int(),
  authorUserId: nullableText,
  createdAt: stamp,
});
const attachmentSchema = z.object({
  id: z.string(),
  originalName: z.string(),
  mimeType: z.string(),
  fileSize: z.number().int().nonnegative(),
  storagePath: z.string().min(1),
  uploadedAt: stamp,
});
const eventSchema = z.object({
  id: z.string(),
  actorId: nullableText,
  kind: eventKind,
  fromValue: nullableText,
  toValue: nullableText,
  note: nullableText,
  createdAt: stamp,
});
const bundleSchema = z.object({
  ticket: ticketSchema.nullable(),
  thread: threadSchema.nullable(),
  responses: z.array(responseSchema).default([]),
  messages: z.array(messageSchema).default([]),
  attachments: z.array(attachmentSchema).default([]),
  events: z.array(eventSchema).default([]),
  appointmentIds: z.array(z.string()).default([]),
});

type SqlRow = Record<string, unknown>;
export interface MigrationDatabase {
  query(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: unknown[]; rowCount: number | null }>;
}
export type LegacySource = { kind: "ticket" | "thread"; id: string };
export class SupportMigrationConflict extends Error {
  constructor(
    readonly code: string,
    readonly sourceId: string,
  ) {
    super(`${code}: ${sourceId}`);
  }
}
export function migrationId(kind: string, id: string): string {
  const hex = createHash("sha256")
    .update(`support-case-drain-v1:${kind}:${id}`)
    .digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
function latest(values: (Date | null)[]): Date | null {
  const dates = values.filter((value): value is Date => value !== null);
  return dates.length
    ? new Date(Math.max(...dates.map((value) => value.getTime())))
    : null;
}

/** Produces one case from a ticket plus its linked thread, or an unlinked thread. */
export function planLegacySupportCase(raw: unknown) {
  const source = bundleSchema.parse(raw);
  const { ticket, thread } = source;
  if (!ticket && !thread)
    throw new SupportMigrationConflict("SOURCE_MISSING", "unknown");
  const key = ticket
    ? { kind: "ticket" as const, id: ticket.id }
    : { kind: "thread" as const, id: thread!.id };
  if (
    ticket &&
    thread &&
    (ticket.userId !== thread.userId || thread.supportTicketId !== ticket.id)
  )
    throw new SupportMigrationConflict("LINK_OWNERSHIP_MISMATCH", key.id);
  if (
    ticket?.organizationId &&
    thread?.organizationId &&
    ticket.organizationId !== thread.organizationId
  )
    throw new SupportMigrationConflict("LINK_ORGANIZATION_MISMATCH", key.id);
  const userId = ticket?.userId ?? thread!.userId;
  const appointmentIds = [
    ...new Set([
      ...source.appointmentIds,
      ...(thread ? [thread.appointmentId] : []),
    ]),
  ];
  if (appointmentIds.length > 1)
    throw new SupportMigrationConflict("AMBIGUOUS_APPOINTMENT_LINK", key.id);
  if (
    ticket &&
    (ticket.consultationId || ticket.subscriptionId) &&
    appointmentIds.length === 0
  )
    throw new SupportMigrationConflict("UNRESOLVED_APPOINTMENT_LINK", key.id);
  const appointmentId = appointmentIds[0] ?? null;
  const caseId = migrationId(key.kind, key.id);
  const organizationId =
    ticket?.organizationId ?? thread?.organizationId ?? null;
  const createdAt = new Date(
    Math.min(
      ...[ticket?.createdAt, thread?.createdAt]
        .filter((value): value is Date => !!value)
        .map((value) => value.getTime()),
    ),
  );
  const messages = [
    ...(ticket
      ? [
          {
            id: migrationId("description", ticket.id),
            sender: "USER",
            body: ticket.description,
            isInternal: false,
            authorUserId: ticket.userId,
            createdAt: ticket.createdAt,
            originalSeq: 0,
            sourceOrder: 0,
            metadata: {
              migrationSource: { kind: "ticket-description", id: ticket.id },
            },
          },
        ]
      : []),
    ...source.messages.map((message) => ({
      id: migrationId("message", message.id),
      sender: message.sender,
      body: message.body,
      isInternal: false,
      authorUserId: message.sender === "USER" ? userId : message.authorUserId,
      createdAt: message.createdAt,
      originalSeq: message.seq,
      sourceOrder: 1,
      metadata: {
        legacyMetadata: message.metadata,
        migrationSource: {
          kind: "thread-message",
          id: message.id,
          seq: message.seq,
        },
      },
    })),
    ...source.responses.map((response) => ({
      id: migrationId("response", response.id),
      sender:
        response.userId === userId && !response.isInternal ? "USER" : "AGENT",
      body: response.message,
      isInternal: response.isInternal,
      authorUserId: response.userId,
      createdAt: response.createdAt,
      originalSeq: 0,
      sourceOrder: 2,
      metadata: {
        migrationSource: { kind: "ticket-response", id: response.id },
      },
    })),
  ]
    .sort(
      (a, b) =>
        a.createdAt.getTime() - b.createdAt.getTime() ||
        a.sourceOrder - b.sourceOrder ||
        a.originalSeq - b.originalSeq ||
        a.id.localeCompare(b.id),
    )
    .map(
      (
        { originalSeq: _originalSeq, sourceOrder: _sourceOrder, ...message },
        index,
      ) => ({ ...message, caseId, seq: index + 1 }),
    );
  const csat = source.events.filter((event) => event.kind === "CSAT_RATED");
  if (csat.length > 1)
    throw new SupportMigrationConflict("MULTIPLE_CSAT_EVENTS", key.id);
  const csatRating = csat.length
    ? z.coerce.number().int().min(1).max(5).parse(csat[0].toValue)
    : null;
  const primary = appointmentId
    ? { subjectType: "APPOINTMENT", subjectId: appointmentId }
    : ticket?.paymentId
      ? { subjectType: "PAYMENT", subjectId: ticket.paymentId }
      : { subjectType: "ACCOUNT", subjectId: userId };
  const subjects = [
    primary,
    ...(ticket?.paymentId && primary.subjectType !== "PAYMENT"
      ? [{ subjectType: "PAYMENT", subjectId: ticket.paymentId }]
      : []),
    ...(ticket?.refundId
      ? [{ subjectType: "REFUND", subjectId: ticket.refundId }]
      : []),
    ...(organizationId
      ? [{ subjectType: "ORGANIZATION", subjectId: organizationId }]
      : []),
  ].map((subject, index) => ({
    ...subject,
    id: migrationId(
      "subject",
      `${caseId}:${subject.subjectType}:${subject.subjectId}`,
    ),
    caseId,
    isPrimary: index === 0,
    createdAt,
  }));
  const aliases = [
    key,
    ...(ticket && thread ? [{ kind: "thread" as const, id: thread.id }] : []),
  ].map((alias) => ({
    id: migrationId("alias", `${alias.kind}:${alias.id}`),
    legacyKind: alias.kind,
    legacyId: alias.id,
    caseId,
  }));
  return {
    source: key,
    aliases,
    supportCase: {
      id: caseId,
      referenceNumber: ticket?.referenceNumber ?? null,
      title: ticket?.title ?? "Booking support",
      description:
        ticket?.description ??
        source.messages.find((message) => message.sender === "USER")?.body ??
        "Legacy booking support conversation",
      category:
        ticket?.category ?? thread?.category ?? ticket?.issueType ?? "OTHER",
      flowKey: thread?.category ?? null,
      currentNodeId: thread?.currentNodeId ?? null,
      activeChannel: thread?.activeChannel ?? "HUMAN",
      issueType: ticket?.issueType ?? null,
      priority: ticket?.priority ?? "MEDIUM",
      status: ticket?.status ?? thread!.status,
      requesterUserId: userId,
      submitterUserId: userId,
      organizationId,
      appointmentId,
      ownershipScope: "PERSONAL",
      scopeKey:
        primary.subjectType === "ACCOUNT"
          ? "ACCOUNT"
          : `${primary.subjectType}:${primary.subjectId}`,
      assignedToId: ticket?.assignedToId ?? null,
      ackDueAt: ticket?.ackDueAt ?? null,
      acknowledgedAt: ticket?.acknowledgedAt ?? null,
      resolutionDueAt: ticket?.resolutionDueAt ?? null,
      resolvedAt: ticket?.resolvedAt ?? thread?.resolvedAt ?? null,
      closedAt: ticket?.closedAt ?? null,
      firstAgentReplyAt: ticket?.firstAgentReplyAt ?? null,
      awaitingUserSince: ticket?.awaitingUserSince ?? null,
      pausedSeconds: ticket?.pausedSeconds ?? 0,
      messageSeq: messages.length,
      lastMessageAt: latest([
        ticket?.lastMessageAt ?? null,
        thread?.lastMessageAt ?? null,
        ...messages
          .filter((message) => !message.isInternal)
          .map((message) => message.createdAt),
      ]),
      csatRating,
      csatAt: csat[0]?.createdAt ?? null,
      createdAt,
      updatedAt:
        latest([ticket?.updatedAt ?? null, thread?.updatedAt ?? null]) ??
        createdAt,
    },
    messages,
    subjects,
    attachments: source.attachments.map((attachment) => ({
      id: migrationId("attachment", attachment.id),
      caseId,
      uploadedById: userId,
      originalName: attachment.originalName,
      mimeType: attachment.mimeType,
      fileSize: attachment.fileSize,
      storagePath: attachment.storagePath,
      completedAt: attachment.uploadedAt,
      createdAt: attachment.uploadedAt,
    })),
    events: source.events.map(({ id, ...event }) => ({
      ...event,
      id: migrationId("event", id),
      caseId,
    })),
  };
}
export type LegacySupportPlan = ReturnType<typeof planLegacySupportCase>;

async function rows<T>(
  db: MigrationDatabase,
  schema: z.ZodType<T>,
  sql: string,
  values: unknown[] = [],
): Promise<T[]> {
  return z.array(schema).parse((await db.query(sql, values)).rows);
}
async function loadSource(
  db: MigrationDatabase,
  source: LegacySource,
): Promise<unknown> {
  const ticket =
    source.kind === "ticket"
      ? ((
          await rows(
            db,
            ticketSchema,
            'SELECT * FROM "SupportTicket" WHERE id = $1',
            [source.id],
          )
        )[0] ?? null)
      : null;
  const thread =
    (
      await rows(
        db,
        threadSchema,
        source.kind === "ticket"
          ? 'SELECT * FROM "AppointmentSupportThread" WHERE "supportTicketId" = $1'
          : 'SELECT * FROM "AppointmentSupportThread" WHERE id = $1 AND "supportTicketId" IS NULL',
        [source.id],
      )
    )[0] ?? null;
  const responses = ticket
    ? await rows(
        db,
        responseSchema,
        'SELECT * FROM "SupportResponse" WHERE "supportTicketId" = $1',
        [ticket.id],
      )
    : [];
  const messages = thread
    ? await rows(
        db,
        messageSchema,
        'SELECT * FROM "SupportMessage" WHERE "threadId" = $1 ORDER BY seq, "createdAt", id',
        [thread.id],
      )
    : [];
  const attachments = ticket
    ? await rows(
        db,
        attachmentSchema,
        'SELECT * FROM "SupportTicketAttachment" WHERE "ticketId" = $1',
        [ticket.id],
      )
    : [];
  const events = ticket
    ? await rows(
        db,
        eventSchema,
        'SELECT * FROM "SupportCaseEvent" WHERE "legacyTicketId" = $1',
        [ticket.id],
      )
    : [];
  const appointmentIds =
    ticket && (ticket.consultationId || ticket.subscriptionId)
      ? (
          await rows(
            db,
            z.object({ id: z.string() }),
            'SELECT id FROM "Appointment" WHERE ("consultationId" = $1 AND $1 IS NOT NULL) OR ("subscriptionId" = $2 AND $2 IS NOT NULL)',
            [ticket.consultationId, ticket.subscriptionId],
          )
        ).map((row) => row.id)
      : [];
  return {
    ticket,
    thread,
    responses,
    messages,
    attachments,
    events,
    appointmentIds,
  };
}

const TARGET_TABLES = [
  "SupportCase",
  "SupportCaseMessage",
  "SupportCaseSubject",
  "SupportCaseAttachment",
  "SupportCaseEvent",
  "SupportCaseLegacyAlias",
] as const;
type TargetTable = (typeof TARGET_TABLES)[number];
async function insertRows(
  db: MigrationDatabase,
  table: TargetTable,
  data: SqlRow[],
): Promise<void> {
  for (let start = 0; start < data.length; start += 100) {
    const batch = data.slice(start, start + 100);
    const fields = Object.keys(batch[0]);
    const values = batch.flatMap((row) => fields.map((field) => row[field]));
    const tuples = batch.map(
      (_, index) =>
        `(${fields.map((__, field) => `$${index * fields.length + field + 1}`).join(", ")})`,
    );
    const result = await db.query(
      `INSERT INTO "${table}" (${fields.map((field) => `"${field}"`).join(", ")}) VALUES ${tuples.join(", ")}`,
      values,
    );
    if (result.rowCount !== batch.length)
      throw new Error(`INSERT_COUNT_MISMATCH: ${table}`);
  }
}
async function verifyPlan(
  db: MigrationDatabase,
  plan: LegacySupportPlan,
): Promise<void> {
  for (const [table, items] of [
    ["SupportCaseMessage", plan.messages],
    ["SupportCaseSubject", plan.subjects],
    ["SupportCaseAttachment", plan.attachments],
    ["SupportCaseEvent", plan.events],
    ["SupportCaseLegacyAlias", plan.aliases],
  ] as const) {
    if (!items.length) continue;
    const result = await rows(
      db,
      z.object({ count: z.coerce.number().int() }),
      `SELECT count(*) AS count FROM "${table}" WHERE "caseId" = $1 AND id = ANY($2::text[])`,
      [plan.supportCase.id, items.map((item) => item.id)],
    );
    if (result[0]?.count !== items.length)
      throw new SupportMigrationConflict(
        `VERIFY_${table.toUpperCase()}_COUNT`,
        plan.source.id,
      );
  }
}

/** All source reads, inserts, aliases and verification share this one client transaction. */
export async function migrateLegacySource(
  db: MigrationDatabase,
  source: LegacySource,
  apply: boolean,
): Promise<{
  outcome: "planned" | "migrated" | "already-migrated";
  counts: { messages: number; attachments: number; events: number };
}> {
  await db.query(
    apply
      ? "BEGIN ISOLATION LEVEL SERIALIZABLE"
      : "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
  );
  try {
    const plan = planLegacySupportCase(await loadSource(db, source));
    const counts = {
      messages: plan.messages.length,
      attachments: plan.attachments.length,
      events: plan.events.length,
    };
    const aliases = await rows(
      db,
      z.object({
        legacyKind: z.string(),
        legacyId: z.string(),
        caseId: z.string(),
      }),
      'SELECT "legacyKind", "legacyId", "caseId" FROM "SupportCaseLegacyAlias" WHERE ("legacyKind" = $1 AND "legacyId" = $2) OR ("legacyKind" = \'thread\' AND "legacyId" = $3)',
      [
        source.kind,
        source.id,
        plan.aliases.find((alias) => alias.legacyKind === "thread")?.legacyId ??
          null,
      ],
    );
    if (aliases.length) {
      if (
        aliases.length !== plan.aliases.length ||
        aliases.some((alias) => alias.caseId !== plan.supportCase.id)
      )
        throw new SupportMigrationConflict("INCONSISTENT_ALIAS", source.id);
      await verifyPlan(db, plan);
      await db.query("COMMIT");
      return { outcome: "already-migrated", counts };
    }
    const conflict = await rows(
      db,
      z.object({ id: z.string() }),
      'SELECT id FROM "SupportCase" WHERE id = $1 OR ("referenceNumber" = $2 AND $2 IS NOT NULL) OR ("scopeKey" = $3 AND "requesterUserId" = $4 AND "submitterUserId" = $4 AND category IS NOT DISTINCT FROM $5 AND "closedAt" IS NULL AND "deletedAt" IS NULL AND $6::boolean)',
      [
        plan.supportCase.id,
        plan.supportCase.referenceNumber,
        plan.supportCase.scopeKey,
        plan.supportCase.requesterUserId,
        plan.supportCase.category,
        plan.supportCase.closedAt === null,
      ],
    );
    if (conflict.length)
      throw new SupportMigrationConflict(
        "EXISTING_UNIFIED_CASE_COLLISION",
        source.id,
      );
    if (plan.attachments.length) {
      const attachmentConflict = await rows(
        db,
        z.object({ id: z.string() }),
        'SELECT id FROM "SupportCaseAttachment" WHERE "storagePath" = ANY($1::text[])',
        [plan.attachments.map((attachment) => attachment.storagePath)],
      );
      if (attachmentConflict.length)
        throw new SupportMigrationConflict(
          "EXISTING_ATTACHMENT_COLLISION",
          source.id,
        );
    }
    if (apply) {
      let referenceNumber = plan.supportCase.referenceNumber;
      if (!referenceNumber) {
        const year = new Date(
          plan.supportCase.createdAt.getTime() + 330 * 60_000,
        ).getUTCFullYear();
        const allocated = await rows(
          db,
          z.object({ nextSeq: z.coerce.number().int().positive() }),
          'INSERT INTO support_ticket_counters (year, "nextSeq", "updatedAt") VALUES ($1, 2, now()) ON CONFLICT (year) DO UPDATE SET "nextSeq" = support_ticket_counters."nextSeq" + 1, "updatedAt" = now() WHERE support_ticket_counters."nextSeq" < 2147483647 RETURNING "nextSeq"',
          [year],
        );
        if (!allocated.length)
          throw new SupportMigrationConflict(
            "REFERENCE_COUNTER_EXHAUSTED",
            source.id,
          );
        referenceNumber = `FAM-${year}-${String(allocated[0].nextSeq - 1).padStart(6, "0")}`;
      }
      await insertRows(db, "SupportCase", [
        { ...plan.supportCase, referenceNumber },
      ]);
      await insertRows(db, "SupportCaseSubject", plan.subjects);
      await insertRows(db, "SupportCaseMessage", plan.messages);
      await insertRows(db, "SupportCaseAttachment", plan.attachments);
      await insertRows(db, "SupportCaseEvent", plan.events);
      await insertRows(db, "SupportCaseLegacyAlias", plan.aliases);
      await verifyPlan(db, plan);
    }
    await db.query("COMMIT");
    return { outcome: apply ? "migrated" : "planned", counts };
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  }
}

export function migrationOptions(argv: string[], env: NodeJS.ProcessEnv) {
  const args = z
    .object({
      apply: z.boolean(),
      batchSize: z.coerce.number().int().min(1).max(500),
      maxSources: z.coerce.number().int().min(1).max(100000),
      ackHost: z.string().optional(),
    })
    .parse(
      argv.reduce(
        (options, arg) => {
          if (arg === "--apply") return { ...options, apply: true };
          if (arg === "--dry-run") return options;
          if (arg.startsWith("--batch-size="))
            return { ...options, batchSize: Number(arg.slice(13)) };
          if (arg.startsWith("--max-sources="))
            return { ...options, maxSources: Number(arg.slice(14)) };
          if (arg.startsWith("--ack-host="))
            return { ...options, ackHost: arg.slice(11) };
          throw new Error(`Unknown option: ${arg}`);
        },
        { apply: false, batchSize: 50, maxSources: 1000 },
      ),
    );
  const connectionString = z
    .string()
    .min(1, "Set SUPPORT_MIGRATION_DATABASE_URL explicitly.")
    .parse(env.SUPPORT_MIGRATION_DATABASE_URL);
  const target = new URL(connectionString);
  if (!["postgres:", "postgresql:"].includes(target.protocol))
    throw new Error("Migration target must be a PostgreSQL URL");
  if (args.apply && args.ackHost !== target.host)
    throw new Error(
      "Apply requires --ack-host exactly matching the dedicated target URL host (including port).",
    );
  return {
    ...args,
    connectionString,
    target: { host: target.host, database: target.pathname.slice(1) },
  };
}

/** Reseeds the existing allocator above every retained legacy and unified FAM reference. */
async function synchronizeCounters(
  db: MigrationDatabase,
  apply: boolean,
): Promise<void> {
  const maxima = await rows(
    db,
    z.object({
      year: z.coerce.number().int(),
      nextSeq: z.coerce.number().int().positive().max(2147483647),
    }),
    `SELECT substring("referenceNumber" from '^FAM-([0-9]{4})-')::integer AS year, max(substring("referenceNumber" from '^FAM-[0-9]{4}-([0-9]+)$')::bigint) + 1 AS "nextSeq" FROM (SELECT "referenceNumber" FROM "SupportTicket" UNION ALL SELECT "referenceNumber" FROM "SupportCase") refs WHERE "referenceNumber" ~ '^FAM-[0-9]{4}-[0-9]+$' GROUP BY year`,
  );
  if (!apply) return;
  for (const maximum of maxima)
    await db.query(
      'INSERT INTO support_ticket_counters (year, "nextSeq", "updatedAt") VALUES ($1, $2, now()) ON CONFLICT (year) DO UPDATE SET "nextSeq" = GREATEST(support_ticket_counters."nextSeq", EXCLUDED."nextSeq"), "updatedAt" = now()',
      [maximum.year, maximum.nextSeq],
    );
}

export async function runSupportMigration(
  db: MigrationDatabase,
  options: { apply: boolean; batchSize: number; maxSources: number },
  report: (event: SqlRow) => void,
) {
  await db.query(
    options.apply ? "BEGIN ISOLATION LEVEL SERIALIZABLE" : "BEGIN READ ONLY",
  );
  try {
    await synchronizeCounters(db, options.apply);
    await db.query("COMMIT");
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  }
  let scanned = 0;
  let failed = 0;
  for (const kind of ["ticket", "thread"] as const) {
    let after = "";
    while (scanned < options.maxSources) {
      const sources = await rows(
        db,
        z.object({ id: z.string() }),
        kind === "ticket"
          ? 'SELECT id FROM "SupportTicket" WHERE id > $1 ORDER BY id LIMIT $2'
          : 'SELECT id FROM "AppointmentSupportThread" WHERE "supportTicketId" IS NULL AND id > $1 ORDER BY id LIMIT $2',
        [after, Math.min(options.batchSize, options.maxSources - scanned)],
      );
      if (!sources.length) break;
      for (const source of sources) {
        after = source.id;
        scanned++;
        try {
          report({
            kind,
            id: source.id,
            ...(await migrateLegacySource(
              db,
              { kind, id: source.id },
              options.apply,
            )),
          });
        } catch (error) {
          failed++;
          report({
            kind,
            id: source.id,
            outcome: "failed",
            code:
              error instanceof SupportMigrationConflict
                ? error.code
                : error instanceof z.ZodError
                  ? "INVALID_SOURCE_DATA"
                  : "DATABASE_OR_VERIFICATION_FAILURE",
          });
        }
      }
    }
  }
  const [coverage] = await rows(
    db,
    z.object({
      missingTicketAliases: z.coerce.number().int(),
      missingThreadAliases: z.coerce.number().int(),
    }),
    `SELECT (SELECT count(*) FROM "SupportTicket" t WHERE NOT EXISTS (SELECT 1 FROM "SupportCaseLegacyAlias" a WHERE a."legacyKind" = 'ticket' AND a."legacyId" = t.id)) AS "missingTicketAliases", (SELECT count(*) FROM "AppointmentSupportThread" t WHERE NOT EXISTS (SELECT 1 FROM "SupportCaseLegacyAlias" a WHERE a."legacyKind" = 'thread' AND a."legacyId" = t.id)) AS "missingThreadAliases"`,
  );
  const summary = {
    scanned,
    failed,
    ...coverage,
    complete:
      failed === 0 &&
      coverage?.missingTicketAliases === 0 &&
      coverage?.missingThreadAliases === 0,
  };
  report({
    event: "support_migration_summary",
    apply: options.apply,
    ...summary,
  });
  return summary;
}

async function main(): Promise<void> {
  const options = migrationOptions(process.argv.slice(2), process.env);
  console.log(
    JSON.stringify({
      event: "support_migration_target",
      mode: options.apply ? "apply" : "dry-run",
      ...options.target,
    }),
  );
  const db = new Client({
    connectionString: options.connectionString,
    application_name: "support-case-migration",
    connectionTimeoutMillis: 10000,
    statement_timeout: 60000,
  });
  await db.connect();
  try {
    const result = await runSupportMigration(db, options, (event) =>
      console.log(JSON.stringify(event)),
    );
    if (result.failed > 0 || (options.apply && !result.complete))
      process.exitCode = 1;
  } finally {
    await db.end();
  }
}
if (require.main === module)
  void main().catch((error: unknown) => {
    console.error(
      error instanceof SupportMigrationConflict
        ? error.message
        : "Support migration refused or failed. Check the target/options and source report; credentials and message content are not logged.",
    );
    process.exitCode = 1;
  });
