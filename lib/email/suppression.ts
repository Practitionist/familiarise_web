import type {
  EmailSuppression,
  EmailSuppressionReason,
  Prisma,
} from "@prisma/client";
import prisma, { type PrismaLike } from "@/lib/prisma";

// #1647 — the addresses the senders must not write to. Rows come from the
// Resend webhook (a permanent bounce or a complaint) or an operator (MANUAL).

type SuppressionDb = Pick<PrismaLike, "emailSuppression">;

/** The one read the relay needs, typed structurally so its test store satisfies it. */
export interface SuppressionReader {
  emailSuppression: {
    findMany(
      args: Prisma.EmailSuppressionFindManyArgs,
    ): Promise<Pick<EmailSuppression, "email" | "reason">[]>;
  };
}

/** The canonical form every suppression read and write keys on. */
export function normaliseEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/** Thrown by `attempt()` in place of a send when the recipient is suppressed. */
export class EmailSuppressedError extends Error {
  constructor(public readonly reason: EmailSuppressionReason) {
    super(`suppressed:${reason}`);
    this.name = "EmailSuppressedError";
  }
}

/**
 * Records a suppression. The empty `update` means an existing row is never
 * downgraded (COMPLAINT stays COMPLAINT) or re-stamped by a later event.
 */
export async function suppressRecipient(
  email: string,
  reason: EmailSuppressionReason,
  sourceEventId?: string,
  db: SuppressionDb = prisma,
) {
  const address = normaliseEmail(email);
  return db.emailSuppression.upsert({
    where: { email: address },
    create: { email: address, reason, sourceEventId: sourceEventId ?? null },
    update: {},
  });
}

/** The suppression row for one address, or null when the address may be written to. */
export async function findSuppression(email: string, db: SuppressionDb) {
  return db.emailSuppression.findUnique({
    where: { email: normaliseEmail(email) },
  });
}

/**
 * The subset of `emails` that is suppressed, keyed by normalised address with
 * the reason as the value, so a caller can stamp `suppressed:<REASON>`.
 */
export async function findSuppressed(
  emails: string[],
  db: SuppressionReader = prisma,
): Promise<Map<string, EmailSuppressionReason>> {
  const addresses = [...new Set(emails.map(normaliseEmail))].filter(Boolean);
  if (addresses.length === 0) return new Map();
  const rows = await db.emailSuppression.findMany({
    where: { email: { in: addresses } },
    select: { email: true, reason: true },
  });
  return new Map(rows.map((row) => [row.email, row.reason]));
}
