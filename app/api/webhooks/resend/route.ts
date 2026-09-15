/**
 * POST /api/webhooks/resend
 *
 * #1647 — Resend's delivery-event receiver. Every signed event becomes an
 * `EmailEvent` row (idempotent on the svix id); a permanent bounce or a
 * complaint also lands the address on `EmailSuppression` and settles its
 * `Waitlist` row, so no sender writes to it again.
 */

import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import type { WebhookEventPayload } from "resend";
import prisma from "@/lib/prisma";
import { isUniqueViolation } from "@/lib/db/pg-errors";
import { getResendClient } from "@/lib/email/deliver";
import { normaliseEmail, suppressRecipient } from "@/lib/email/suppression";
import {
  MAX_WEBHOOK_BODY_BYTES,
  readBodyWithinCap,
} from "@/lib/webhooks/read-body";

export const dynamic = "force-dynamic";
// Signature verification is Node-only (the SDK's standardwebhooks dependency).
export const runtime = "nodejs";

function notConfigured(reason: "not_configured" | "no_api_key") {
  Sentry.captureMessage(
    reason === "no_api_key"
      ? "Resend webhook cannot verify: RESEND_API_KEY missing"
      : "Resend webhook secret missing",
    {
      level: "error",
      fingerprint: ["resend-webhook", reason],
      tags: { subsystem: "email" },
    },
  );
  return NextResponse.json(
    { error: "webhook not configured" },
    { status: 503 },
  );
}

// The event fields the side effects read; every other type is stored as-is.
interface EmailEventData {
  email_id?: string;
  to?: string[];
  bounce?: { type?: string };
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
  if (!webhookSecret) return notConfigured("not_configured");
  const client = getResendClient();
  if (!client) return notConfigured("no_api_key");

  // The body is never logged on a rejection: an unsigned payload is untrusted input.
  let event: WebhookEventPayload;
  try {
    event = client.webhooks.verify({
      payload: raw,
      headers: { id, timestamp, signature },
      webhookSecret,
    });
  } catch {
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }

  const type = event.type;
  const data = (event.data ?? {}) as EmailEventData;
  // Some non-email event types carry no email id; the column is required.
  const resendId = data.email_id ?? "";
  const recipient = normaliseEmail(data.to?.[0] ?? "");

  let eventRow: { id: string };
  try {
    eventRow = await prisma.emailEvent.create({
      data: {
        svixId: id,
        resendId,
        type,
        recipient,
        payload: event as unknown as Prisma.InputJsonValue,
      },
      select: { id: true },
    });
  } catch (error) {
    // A redelivery or a dashboard replay carries the same svix id: already stored.
    if (isUniqueViolation(error)) {
      return NextResponse.json({ received: true, duplicate: true });
    }
    // Nothing is durable yet, so a 500 is right: Resend retries the delivery.
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      {
        tags: { subsystem: "email" },
        fingerprint: ["resend-webhook", "store"],
      },
    );
    return NextResponse.json({ error: "event not stored" }, { status: 500 });
  }

  // #1647 — a Transient bounce (full mailbox, greylisting) is not a dead
  // address, so only a Permanent bounce or a complaint suppresses.
  try {
    if (
      recipient &&
      type === "email.bounced" &&
      data.bounce?.type === "Permanent"
    ) {
      await suppressRecipient(recipient, "HARD_BOUNCE", eventRow.id);
      await prisma.waitlist.updateMany({
        where: { email: recipient, status: { in: ["PENDING", "SUBSCRIBED"] } },
        data: { status: "BOUNCED" },
      });
    } else if (recipient && type === "email.complained") {
      await suppressRecipient(recipient, "COMPLAINT", eventRow.id);
      await prisma.waitlist.updateMany({
        where: { email: recipient, status: { in: ["PENDING", "SUBSCRIBED"] } },
        data: { status: "UNSUBSCRIBED", unsubscribedAt: new Date() },
      });
    }
  } catch (error) {
    // The event row is durable, so answer 200: a retry from Resend would only
    // hit the duplicate path and never re-run this write.
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      {
        tags: { subsystem: "email" },
        fingerprint: ["resend-webhook", "side-effect"],
      },
    );
  }

  return NextResponse.json({ received: true });
}
