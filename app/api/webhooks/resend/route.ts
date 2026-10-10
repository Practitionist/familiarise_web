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
import prisma, { type PrismaLike } from "@/lib/prisma";
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
  type ResendWebhookEvent,
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
  if (typeof value === "bigint") {
    return value.toString();
  }
  return "";
}

function toErrorInstance(error: unknown): Error {
  if (error instanceof Error) return error;
  if (typeof error === "string") return new Error(error);
  return new Error(JSON.stringify(error) ?? "Unknown error");
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

async function suppressRecipientsInTx(
  tx: PrismaLike,
  recipients: string[],
  reason: "HARD_BOUNCE" | "COMPLAINT" | "MANUAL",
  eventRowId: string,
): Promise<void> {
  for (const recipient of recipients) {
    await suppressRecipient(recipient, reason, eventRowId, tx);
  }
}

async function applyRecipientEffects(
  tx: PrismaLike,
  eventRowId: string,
  type: string,
  data: ResendWebhookEvent["data"],
  recipients: string[],
): Promise<void> {
  if (recipients.length === 0) return;

  const emailFilter =
    recipients.length === 1 ? recipients[0] : { in: recipients };

  if (type === "email.bounced" && data?.bounce?.type === "Permanent") {
    await suppressRecipientsInTx(tx, recipients, "HARD_BOUNCE", eventRowId);
    await tx.waitlist.updateMany({
      where: {
        email: emailFilter,
        status: { in: ["PENDING", "SUBSCRIBED"] },
      },
      data: { status: "BOUNCED" },
    });
    return;
  }

  if (type === "email.complained") {
    await suppressRecipientsInTx(tx, recipients, "COMPLAINT", eventRowId);
    await tx.waitlist.updateMany({
      where: {
        email: emailFilter,
        status: { in: ["PENDING", "SUBSCRIBED"] },
      },
      data: { status: "UNSUBSCRIBED", unsubscribedAt: new Date() },
    });
    return;
  }

  if (type === "email.suppressed") {
    await suppressRecipientsInTx(tx, recipients, "MANUAL", eventRowId);
    await tx.waitlist.updateMany({
      where: {
        email: emailFilter,
        status: { in: ["PENDING", "SUBSCRIBED"] },
      },
      data: { status: "BOUNCED" },
    });
    return;
  }

  if (
    type === "contact.deleted" ||
    (type === "contact.updated" && data?.unsubscribed === true)
  ) {
    await suppressRecipientsInTx(tx, recipients, "MANUAL", eventRowId);
    await tx.waitlist.updateMany({
      where: {
        email: emailFilter,
        status: { in: ["PENDING", "SUBSCRIBED"] },
      },
      data: { status: "UNSUBSCRIBED", unsubscribedAt: new Date() },
    });
  }
}

async function reportDegradedDomainIfNeeded(
  svixId: string,
  type: string,
  data: NonNullable<ResendWebhookEvent["data"]>,
): Promise<void> {
  const isDegradedUpdate =
    type === "domain.updated" &&
    (data.status === "failed" || data.status === "not_started");
  if (type !== "domain.deleted" && !isDegradedUpdate) {
    return;
  }

  await recordSystemErrorSafe({
    category: "WEBHOOK",
    summary: `Resend sending domain degraded (${type})`,
    err: new Error(`Domain status reported as ${data.status ?? "deleted"}`),
    context: {
      provider: "resend",
      svixId,
      type,
      domainId: data.id ?? null,
      domainName: data.name ?? null,
      status: data.status ?? "deleted",
    },
  });
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

      await applyRecipientEffects(tx, eventRow.id, type, data, recipients);
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      return NextResponse.json({ received: true, duplicate: true });
    }
    Sentry.captureException(toErrorInstance(error), {
      tags: { subsystem: "email" },
      fingerprint: ["resend-webhook", "store"],
    });
    return NextResponse.json({ error: "event not stored" }, { status: 500 });
  }

  await reportDegradedDomainIfNeeded(id, type, data);

  return NextResponse.json({ received: true });
}
