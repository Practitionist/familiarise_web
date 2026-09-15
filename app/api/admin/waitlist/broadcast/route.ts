/**
 * POST /api/admin/waitlist/broadcast
 *
 * Sends one newsletter to every SUBSCRIBED address via Resend's batch API
 * (100 per call). Every message carries an unsubscribe link in the footer and
 * the List-Unsubscribe headers that let mail clients offer one-click opt-out.
 */

import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { requireAdminAuth } from "@/lib/auth-helpers";
import { getResendClient, SENDERS } from "@/lib/email";
import { createHash } from "node:crypto";
import { resendErrorText } from "@/lib/email/classify";
import { companyPostalAddress } from "@/lib/email/config";
import { findSuppressed } from "@/lib/email/suppression";
import prisma from "@/lib/prisma";
import { listSendableSubscribers } from "@/lib/waitlist/service";
import { buildUnsubscribeUrl } from "@/lib/waitlist/tokens";

const sendSchema = z.object({
  subject: z.string().trim().min(1, "Subject is required").max(200),
  htmlBody: z.string().min(1, "Email body is required"),
  textBody: z.string().optional(),
});

const BATCH_SIZE = 100;

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const auth = await requireAdminAuth();
    if (auth.error) return auth.error;

    const body = await request.json().catch(() => null);
    const parsed = sendSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid input", details: parsed.error.flatten() },
        { status: 400 },
      );
    }
    const { subject, htmlBody, textBody } = parsed.data;

    // #1298 — a marketing send without a postal address is not compliant
    // (CAN-SPAM §5(a)(5)); refuse in production rather than ship it bare.
    if (process.env.NODE_ENV === "production" && !companyPostalAddress()) {
      return NextResponse.json(
        {
          error:
            "NEXT_PUBLIC_COMPANY_POSTAL_ADDRESS is not set; newsletter sends need a postal address in the footer",
        },
        { status: 412 },
      );
    }

    const resend = getResendClient();
    if (!resend) {
      return NextResponse.json(
        { error: "Email service not configured (RESEND_API_KEY missing)" },
        { status: 503 },
      );
    }

    const allSubscribers = await listSendableSubscribers();
    // #1647 — a bounced or complaining address stays SUBSCRIBED only until the
    // webhook settles it; the suppression list is the authority either way.
    const suppressed = await findSuppressed(allSubscribers.map((s) => s.email));
    const subscribers = allSubscribers.filter((s) => !suppressed.has(s.email));
    const skippedSuppressed = allSubscribers.length - subscribers.length;
    if (subscribers.length === 0) {
      return NextResponse.json(
        { error: "No confirmed subscribers to send to", skippedSuppressed },
        { status: 404 },
      );
    }

    let sent = 0;
    let failed = 0;
    const errors: string[] = [];

    for (let i = 0; i < subscribers.length; i += BATCH_SIZE) {
      const batch = subscribers.slice(i, i + BATCH_SIZE);
      const emails = batch.map((sub) =>
        buildMessage(sub.email, subject, htmlBody, textBody),
      );

      const outcome = await sendBatch(resend, emails);
      if (outcome.ok) {
        sent += outcome.sent;
      } else {
        failed += batch.length;
        errors.push(
          `Batch ${Math.floor(i / BATCH_SIZE) + 1}: ${outcome.error}`,
        );
      }
    }

    console.log(
      `[admin/waitlist/broadcast] sent=${sent} failed=${failed} total=${subscribers.length} skippedSuppressed=${skippedSuppressed}`,
    );

    return NextResponse.json({
      success: true,
      sent,
      failed,
      total: subscribers.length,
      skippedSuppressed,
      ...(errors.length > 0 && { errors }),
    });
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "waitlist" } },
    );
    console.error("[admin/waitlist/broadcast]", error);
    return NextResponse.json(
      { error: "Failed to send the newsletter" },
      { status: 500 },
    );
  }
}

type BroadcastMessage = ReturnType<typeof buildMessage>;

function buildMessage(
  email: string,
  subject: string,
  htmlBody: string,
  textBody: string | undefined,
) {
  const unsubscribeUrl = buildUnsubscribeUrl(email);
  return {
    from: SENDERS.newsletter,
    to: email,
    subject,
    html: appendUnsubscribeFooter(htmlBody, unsubscribeUrl),
    text: textBody,
    headers: {
      "List-Unsubscribe": `<${unsubscribeUrl}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
  };
}

/**
 * Sends one batch. #1647 — the batch is a `FailedEmailBatch` row before the
 * request goes out, so a lost response or a failed send is replayed by the
 * relay under the same idempotency key. No per-message rows: a batch replay
 * plus per-message replays would send twice, since the two keys differ.
 */
async function sendBatch(
  resend: NonNullable<ReturnType<typeof getResendClient>>,
  emails: BroadcastMessage[],
): Promise<{ ok: true; sent: number } | { ok: false; error: string }> {
  // #1298 — one key per batch request, derived from its content like the
  // single-send path, so an admin re-submit inside 24 h cannot double-send.
  const idempotencyKey = batchIdempotencyKey(emails);
  const row = await prisma.failedEmailBatch.upsert({
    where: { idempotencyKey },
    create: {
      idempotencyKey,
      emailType: "WAITLIST_BROADCAST",
      // Exactly what resend.batch.send accepts, so the relay passes it through.
      payload: emails as Prisma.InputJsonValue,
    },
    update: {},
    select: { id: true },
  });
  try {
    const result = await resend.batch.send(emails, { idempotencyKey });
    if (result.error) {
      throw new Error(resendErrorText(result.error));
    }
    await settleBatch(row.id, {
      status: "SENT",
      sentAt: new Date(),
      lastError: null,
    });
    return { ok: true, sent: result.data?.data?.length ?? emails.length };
  } catch (batchError) {
    const error =
      batchError instanceof Error ? batchError.message : "Unknown error";
    // Left PENDING with the cause: the relay replays it on its next tick.
    await settleBatch(row.id, { lastError: error });
    return { ok: false, error };
  }
}

// Best-effort like deliver.ts's settleRow: the send outcome is decided, and a
// row left PENDING only costs a replay that Resend's key deduplicates.
async function settleBatch(
  id: string,
  data: Prisma.FailedEmailBatchUpdateInput,
): Promise<void> {
  try {
    await prisma.failedEmailBatch.update({ where: { id }, data });
  } catch (updateError) {
    console.error(
      "[admin/waitlist/broadcast] batch row update failed:",
      updateError,
    );
  }
}

function appendUnsubscribeFooter(html: string, unsubscribeUrl: string): string {
  const line = `style="font-size:12px;color:#666;margin:10px 0;line-height:1.5"`;
  // #1298 — same postal line EmailFooter renders, so marketing mail carries it.
  const postal = companyPostalAddress();
  const postalLine = postal ? `\n  <p ${line}>${escapeHtml(postal)}</p>` : "";
  const footer = `
<div style="text-align:center;margin:30px 0 0;padding:20px 0;border-top:1px solid #eee">
  <p ${line}>
    &copy; ${new Date().getFullYear()} Familiarise. All rights reserved.
  </p>${postalLine}
  <p ${line}>
    You received this because you joined the Familiarise waitlist.
    <br/>
    <a href="${unsubscribeUrl}" style="color:#666;text-decoration:underline">Unsubscribe</a>
  </p>
</div>`;

  if (html.includes("</body>"))
    return html.replace("</body>", `${footer}</body>`);
  if (html.includes("</html>"))
    return html.replace("</html>", `${footer}</html>`);
  return html + footer;
}

function batchIdempotencyKey(emails: BroadcastMessage[]): string {
  // Every field Resend compares (to, subject, html, text) per recipient, in
  // code-point order — a text-only correction must not collide for 24 h (409).
  const payloads = emails
    .map((e) => JSON.stringify([e.to, e.subject, e.html, e.text ?? ""]))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const digest = createHash("sha256").update(payloads.join("\n")).digest("hex");
  return `WAITLIST_BROADCAST/${digest.slice(0, 48)}`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
