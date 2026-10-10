/**
 * POST /api/webhooks/resend
 *
 * Resend Svix webhook receiver. Persists `EmailEvent` and recipient suppression / waitlist
 * state transitions atomically inside a single transaction.
 */

import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { Resend } from "resend";
import prisma from "@/lib/prisma";
import { isUniqueViolation } from "@/lib/db/pg-errors";
import { suppressRecipient } from "@/lib/email/suppression";
import { recordSystemErrorSafe } from "@/lib/enterprise/system-events";
import {
  MAX_WEBHOOK_BODY_BYTES,
  readBodyWithinCap,
} from "@/lib/webhooks/read-body";
import {
  extractResendRecipients,
  resendWebhookEventSchema,
} from "@/schemas/webhooks/resend";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function toInputJson(value: unknown): Prisma.InputJsonValue {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(toInputJson);
  }
  if (typeof value === "object" && value !== null) {
    const out: { [key: string]: Prisma.InputJsonValue | null } = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = v === null ? null : toInputJson(v);
    }
    return out;
  }
  return String(value ?? "");
}

function notConfigured() {
  Sentry.captureMessage("Resend webhook secret missing", {
    level: "error",
    fingerprint: ["resend-webhook", "not_configured"],
    tags: { subsystem: "email" },
  });
  return NextResponse.json(
    { error: "webhook not configured" },
    { status: 503 },
  );
}

export async function POST(req: NextRequest) {
  const declaredBytes = Number(req.headers.get("content-length"));
  if (
    Number.isFinite(declaredBytes) &&
    declaredBytes > MAX_WEBHOOK_BODY_BYTES
  ) {
    return NextResponse.json({ error: "Payload too large" }, { status: 413 });
  }

  const id = req.headers.get("svix-id");
  const timestamp = req.headers.get("svix-timestamp");
  const signature = req.headers.get("svix-signature");
  if (!id || !timestamp || !signature) {
    return NextResponse.json(
      { error: "missing signature headers" },
      { status: 400 },
    );
  }

  const raw = await readBodyWithinCap(req);
  if (raw === null) {
    return NextResponse.json({ error: "Payload too large" }, { status: 413 });
  }

  const webhookSecret = process.env.RESEND_WEBHOOK_SECRET;
  if (!webhookSecret) return notConfigured();

  let verifiedRaw: unknown;
  try {
    const verifier = new Resend(
      process.env.RESEND_API_KEY ?? "re_webhook_verify_only",
    );
    verifiedRaw = verifier.webhooks.verify({
      payload: raw,
      headers: { id, timestamp, signature },
      webhookSecret,
    });
  } catch {
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }

  const parsed = resendWebhookEventSchema.safeParse(verifiedRaw);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid payload" }, { status: 400 });
  }

  const event = parsed.data;
  const type = event.type;
  const data = event.data ?? {};
  const resendId = data.email_id ?? "";
  const recipients = extractResendRecipients(event);
  const primaryRecipient = recipients[0] ?? "";
  const emailFilter =
    recipients.length === 1 ? recipients[0] : { in: recipients };

  try {
    await prisma.$transaction(async (tx) => {
      const eventRow = await tx.emailEvent.create({
        data: {
          svixId: id,
          resendId,
          type,
          recipient: primaryRecipient,
          payload: toInputJson(event),
        },
        select: { id: true },
      });

      if (
        recipients.length > 0 &&
        type === "email.bounced" &&
        data.bounce?.type === "Permanent"
      ) {
        for (const recipient of recipients) {
          await suppressRecipient(recipient, "HARD_BOUNCE", eventRow.id, tx);
        }
        await tx.waitlist.updateMany({
          where: {
            email: emailFilter,
            status: { in: ["PENDING", "SUBSCRIBED"] },
          },
          data: { status: "BOUNCED" },
        });
      } else if (recipients.length > 0 && type === "email.complained") {
        for (const recipient of recipients) {
          await suppressRecipient(recipient, "COMPLAINT", eventRow.id, tx);
        }
        await tx.waitlist.updateMany({
          where: {
            email: emailFilter,
            status: { in: ["PENDING", "SUBSCRIBED"] },
          },
          data: { status: "UNSUBSCRIBED", unsubscribedAt: new Date() },
        });
      } else if (
        recipients.length > 0 &&
        (type === "email.suppressed" || type === "suppression.added")
      ) {
        for (const recipient of recipients) {
          await suppressRecipient(recipient, "MANUAL", eventRow.id, tx);
        }
        await tx.waitlist.updateMany({
          where: {
            email: emailFilter,
            status: { in: ["PENDING", "SUBSCRIBED"] },
          },
          data: { status: "BOUNCED" },
        });
      } else if (recipients.length > 0 && type === "suppression.removed") {
        await tx.emailSuppression.deleteMany({
          where: { email: emailFilter },
        });
      } else if (
        recipients.length > 0 &&
        (type === "contact.deleted" ||
          (type === "contact.updated" && data.unsubscribed === true))
      ) {
        for (const recipient of recipients) {
          await suppressRecipient(recipient, "MANUAL", eventRow.id, tx);
        }
        await tx.waitlist.updateMany({
          where: {
            email: emailFilter,
            status: { in: ["PENDING", "SUBSCRIBED"] },
          },
          data: { status: "UNSUBSCRIBED", unsubscribedAt: new Date() },
        });
      }
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      return NextResponse.json({ received: true, duplicate: true });
    }
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      {
        tags: { subsystem: "email" },
        fingerprint: ["resend-webhook", "store"],
      },
    );
    return NextResponse.json({ error: "event not stored" }, { status: 500 });
  }

  if (
    type === "domain.deleted" ||
    (type === "domain.updated" &&
      (data.status === "failed" || data.status === "not_started"))
  ) {
    await recordSystemErrorSafe({
      category: "WEBHOOK",
      summary: `Resend sending domain degraded (${type})`,
      err: new Error(`Domain status reported as ${data.status ?? "deleted"}`),
      context: {
        provider: "resend",
        svixId: id,
        type,
        domainId: data.id ?? null,
        domainName: data.name ?? null,
        status: data.status ?? "deleted",
      },
    });
  }

  return NextResponse.json({ received: true });
}
