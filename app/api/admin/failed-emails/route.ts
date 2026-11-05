/** Lists delivery evidence and requeues eligible dead letters through the audited ops door. */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { requireBackofficeSurface } from "@/lib/auth-helpers";
import { withOpsAction } from "@/lib/backoffice/ops-action-log";
import { OpsRefusal } from "@/lib/backoffice/ops-refusal-error";
import {
  emailReplayRefusal,
  EMAIL_REPLAY_EXPLANATIONS,
} from "@/lib/email/replay-policy";
import {
  emailDeliveryPolicySchema,
  emailPolicyRefusalForUser,
  EMAIL_POLICY_USER_SELECT,
} from "@/lib/email/delivery-policy";
import { findSuppressed, normaliseEmail } from "@/lib/email/suppression";
import { DEAD_LETTER_EMAIL_WHERE } from "@/lib/backoffice/queue-predicates";

const StatusSchema = z.enum(["PENDING", "RETRY", "SENT", "DEAD_LETTER"]);

export async function GET(req: NextRequest) {
  const auth = await requireBackofficeSurface("compliance.manage");
  if (auth.error) return auth.error;

  const url = new URL(req.url);
  const limit = Math.min(
    Math.max(parseInt(url.searchParams.get("limit") ?? "50", 10) || 50, 1),
    200,
  );
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
  const rows = await prisma.failedEmail.findMany({
    where,
    orderBy: { createdAt: "desc" },
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
          status: true,
          emailType: true,
          lastError: true,
          resendId: true,
          sentAt: true,
          createdAt: true,
          updatedAt: true,
          recipient: true,
          deliveryPolicy: true,
        },
      });
      if (rows.length !== ids.length)
        throw new OpsRefusal(
          "EMAIL_NOT_FOUND",
          "One or more messages no longer exist.",
          404,
        );
      const now = new Date();
      const policies = rows.map((row) => ({
        row,
        policy:
          row.deliveryPolicy === null
            ? null
            : emailDeliveryPolicySchema.safeParse(row.deliveryPolicy),
      }));
      const userIds = [
        ...new Set(
          policies.flatMap(({ policy }) =>
            policy?.success ? [policy.data.userId] : [],
          ),
        ),
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
      for (const { row, policy } of policies) {
        const refusal = emailReplayRefusal(row, now);
        if (refusal)
          throw new OpsRefusal(
            "EMAIL_REPLAY_REFUSED",
            EMAIL_REPLAY_EXPLANATIONS[refusal],
            409,
            { failedEmailId: row.id, reason: refusal },
          );
        const policyRefused =
          policy &&
          (!policy.success ||
            emailPolicyRefusalForUser(
              policy.data,
              row.recipient,
              byId.get(policy.data.userId) ?? null,
            ));
        if (policyRefused || suppressed.has(normaliseEmail(row.recipient)))
          throw new OpsRefusal(
            "EMAIL_RECIPIENT_REFUSED",
            "Current recipient policy or suppression prevents this message.",
            409,
            { failedEmailId: row.id },
          );
      }
      const requeued = await tx.failedEmail.updateMany({
        where: {
          status: "DEAD_LETTER",
          OR: rows.map((row) => ({ id: row.id, updatedAt: row.updatedAt })),
        },
        data: {
          status: "PENDING",
          attempts: 0,
          nextRetryAt: now,
          lastError: null,
        },
      });
      if (requeued.count !== ids.length)
        throw new OpsRefusal(
          "EMAIL_REPLAY_RACED",
          "A message changed while it was being reviewed. Refresh and try again.",
        );
      return {
        target: { kind: "FailedEmail", id: ids[0] },
        response: { requeued: requeued.count },
        before: { ids, status: "DEAD_LETTER" },
        after: { ids, status: "PENDING" },
      };
    },
  },
);
