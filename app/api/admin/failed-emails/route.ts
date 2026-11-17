/**
 * GET  /api/admin/failed-emails
 * POST /api/admin/failed-emails
 *
 * #474 — operator surface for the transactional-email dead-letter queue.
 *
 *  - `GET` lists FailedEmail rows (most recent first), optionally filtered to
 *    a single `status` (e.g. DEAD_LETTER) for triage.
 *
 *  - `POST { ids: [...], reason }` requeues DEAD_LETTER rows through the
 *    audited ops door: status → PENDING, nextRetryAt → now, attempts reset to
 *    0 so the backoff schedule restarts. The worker
 *    (jobs/email/retry-failed-emails.ts) replays the stored html/text VERBATIM
 *    on its next tick — no re-render, no dispatcher. Credential mail, holds,
 *    accepted rows, recipient refusals and rows past the provider window are
 *    refused (lib/email/replay-policy.ts), as is a recipient whose current
 *    preferences or suppression would stop the send. The prior failure reason
 *    stays on the row and in the audit record.
 *
 * Access: `compliance.manage` (admin only, #1527 Q5 — tightened from
 * privileged, which admitted staff). The rendered bodies can carry
 * payment/PII detail, so this never reaches an org UI.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { requireBackofficeSurface } from "@/lib/auth-helpers";
import { withOpsAction } from "@/lib/backoffice/ops-action-log";
import { OpsRefusal } from "@/lib/backoffice/ops-refusal-error";
import { readPageParams } from "@/lib/backoffice/list-paging";
import { DEAD_LETTER_EMAIL_WHERE } from "@/lib/backoffice/queue-predicates";
import {
  deliveryPolicyOf,
  emailPolicyRefusalForUser,
  EMAIL_POLICY_USER_SELECT,
} from "@/lib/email/delivery-policy";
import {
  emailReplayRefusal,
  EMAIL_REPLAY_EXPLANATIONS,
} from "@/lib/email/replay-policy";
import { findSuppressed, normaliseEmail } from "@/lib/email/suppression";

const StatusSchema = z.enum(["PENDING", "RETRY", "SENT", "DEAD_LETTER"]);

export async function GET(req: NextRequest) {
  const auth = await requireBackofficeSurface("compliance.manage");
  if (auth.error) return auth.error;

  const url = new URL(req.url);
  const { page, limit, skip } = readPageParams(url.searchParams, 50);
  const statusParam = url.searchParams.get("status");
  const status = statusParam ? StatusSchema.safeParse(statusParam) : undefined;
  if (status && !status.success) {
    return NextResponse.json({ error: "Invalid status" }, { status: 400 });
  }

  // The dead-letter view shares the nav badge's predicate (pre-launch holds
  // excluded); "All" still lists held rows.
  const where = status?.success
    ? status.data === "DEAD_LETTER"
      ? DEAD_LETTER_EMAIL_WHERE
      : { status: status.data }
    : undefined;
  const total = await prisma.failedEmail.count({ where });
  const rows = await prisma.failedEmail.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    skip,
    take: limit,
    // Don't ship the rendered html/text bodies in the list view — they can be
    // large and carry PII. Operators replay by id; detail isn't needed here.
    select: {
      id: true,
      recipient: true,
      subject: true,
      emailType: true,
      status: true,
      attempts: true,
      nextRetryAt: true,
      lastError: true,
      sentAt: true,
      resendId: true,
      firstAttemptAt: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  const now = new Date();
  return NextResponse.json({
    data: rows.map((row) => ({
      ...row,
      replayRefusal: emailReplayRefusal(row, now),
    })),
    total,
    page,
    pageSize: limit,
  });
}

export const POST = withOpsAction(
  "compliance.manage",
  "email.retry",
  { ids: z.array(z.string().min(1)).min(1).max(200) },
  {
    mode: "tx",
    async run(tx, { body }) {
      const ids = [...new Set(body.ids)];
      const rows = await tx.failedEmail.findMany({
        where: { id: { in: ids } },
        select: {
          id: true,
          recipient: true,
          status: true,
          emailType: true,
          lastError: true,
          resendId: true,
          sentAt: true,
          firstAttemptAt: true,
          deliveryUserId: true,
          deliveryCategory: true,
          updatedAt: true,
        },
      });
      const now = new Date();
      for (const row of rows) {
        const refusal = emailReplayRefusal(row, now);
        if (refusal) {
          throw new OpsRefusal(
            "EMAIL_REPLAY_REFUSED",
            EMAIL_REPLAY_EXPLANATIONS[refusal],
            409,
            { failedEmailId: row.id, reason: refusal },
          );
        }
      }

      const userIds = [
        ...new Set(rows.flatMap((row) => row.deliveryUserId ?? [])),
      ];
      const users =
        userIds.length > 0
          ? await tx.user.findMany({
              where: { id: { in: userIds } },
              select: { ...EMAIL_POLICY_USER_SELECT, id: true },
            })
          : [];
      const byId = new Map(users.map((user) => [user.id, user]));
      const suppressed = await findSuppressed(
        rows.map((row) => row.recipient),
        tx,
      );
      for (const row of rows) {
        const policy = deliveryPolicyOf(row);
        const policyRefused =
          policy !== null &&
          emailPolicyRefusalForUser(
            policy,
            row.recipient,
            byId.get(policy.userId) ?? null,
          ) !== null;
        if (policyRefused || suppressed.has(normaliseEmail(row.recipient))) {
          throw new OpsRefusal(
            "EMAIL_RECIPIENT_REFUSED",
            "The recipient's current preferences or suppression prevent this message.",
            409,
            { failedEmailId: row.id },
          );
        }
      }

      // CAS on (status, updatedAt): skips a row anything touched since the read.
      const requeued = await tx.failedEmail.updateMany({
        where: {
          status: "DEAD_LETTER",
          OR: rows.map((row) => ({ id: row.id, updatedAt: row.updatedAt })),
        },
        data: { status: "PENDING", attempts: 0, nextRetryAt: now },
      });
      if (requeued.count !== ids.length) {
        throw new OpsRefusal(
          "EMAIL_REPLAY_RACED",
          "A message changed or disappeared while it was being reviewed. Refresh and try again.",
        );
      }
      return {
        target: { kind: "FailedEmail", id: ids[0] },
        response: { requeued: requeued.count },
        before: {
          status: "DEAD_LETTER",
          rows: rows.map((row) => ({ id: row.id, lastError: row.lastError })),
        },
        after: { ids, status: "PENDING" },
      };
    },
  },
);
