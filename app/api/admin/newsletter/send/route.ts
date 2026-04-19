/**
 * POST /api/admin/newsletter/send
 *
 * Admin-only route to send a newsletter to all active subscribers.
 * Uses Resend batch API (100 emails per call).
 * Appends unsubscribe link to every email footer.
 *
 * This is an interim solution until ConvertKit is integrated (Issue #334).
 */

import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAdminAuth } from "@/lib/auth-helpers";
import { Resend } from "resend";
import { z } from "zod";
import { buildUnsubscribeUrl } from "@/lib/newsletter/unsubscribe";

const sendSchema = z.object({
  subject: z.string().min(1, "Subject is required").max(200),
  htmlBody: z.string().min(1, "Email body is required"),
  textBody: z.string().optional(),
});

const BATCH_SIZE = 100;

let resendClient: Resend | null = null;

function getResendClient(): Resend | null {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return null;
  if (!resendClient) resendClient = new Resend(apiKey);
  return resendClient;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    // Auth check
    const auth = await requireAdminAuth();
    if (auth.error) return auth.error;

    // Validate input
    const body = await req.json();
    const parsed = sendSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid input", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const { subject, htmlBody, textBody } = parsed.data;

    // Check Resend config
    const resend = getResendClient();
    if (!resend) {
      return NextResponse.json(
        { error: "Email service not configured (RESEND_API_KEY missing)" },
        { status: 503 },
      );
    }

    // Query active subscribers
    const subscribers = await prisma.newsletter.findMany({
      where: { unsubscribed: false },
      select: { email: true },
    });

    if (subscribers.length === 0) {
      return NextResponse.json(
        { error: "No active subscribers" },
        { status: 404 },
      );
    }

    // Send in batches
    let sent = 0;
    let failed = 0;
    const errors: string[] = [];

    for (let i = 0; i < subscribers.length; i += BATCH_SIZE) {
      const batch = subscribers.slice(i, i + BATCH_SIZE);

      const emails = batch.map((sub) => {
        const unsubscribeUrl = buildUnsubscribeUrl(sub.email);
        const htmlWithFooter = appendUnsubscribeFooter(
          htmlBody,
          unsubscribeUrl,
        );
        return {
          from: "Familiarise <newsletter@familiarise.com>",
          to: sub.email,
          subject,
          html: htmlWithFooter,
          text: textBody,
          headers: {
            "List-Unsubscribe": `<${unsubscribeUrl}>`,
            "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
          },
        };
      });

      try {
        const result = await resend.batch.send(emails);
        if (result.error) {
          failed += batch.length;
          errors.push(
            `Batch ${Math.floor(i / BATCH_SIZE) + 1}: ${result.error.message}`,
          );
        } else {
          sent += result.data?.length ?? batch.length;
          const failedInBatch =
            batch.length - (result.data?.length ?? batch.length);
          if (failedInBatch > 0) failed += failedInBatch;
        }
      } catch (batchError) {
        failed += batch.length;
        errors.push(
          `Batch ${Math.floor(i / BATCH_SIZE) + 1}: ${batchError instanceof Error ? batchError.message : "Unknown error"}`,
        );
      }
    }

    console.log(
      `[admin/newsletter/send] Sent: ${sent}, Failed: ${failed}, Total subscribers: ${subscribers.length}`,
    );

    return NextResponse.json({
      success: true,
      sent,
      failed,
      total: subscribers.length,
      ...(errors.length > 0 && { errors }),
    });
  } catch (error) {
    console.error("[admin/newsletter/send] Error:", error);
    return NextResponse.json(
      { error: "Failed to send newsletter" },
      { status: 500 },
    );
  }
}

function appendUnsubscribeFooter(html: string, unsubscribeUrl: string): string {
  const footer = `
<div style="text-align:center;margin:30px 0 0;padding:20px 0;border-top:1px solid #eee">
  <p style="font-size:12px;color:#666;margin:10px 0;line-height:1.5">
    &copy; ${new Date().getFullYear()} Familiarise. All rights reserved.
  </p>
  <p style="font-size:12px;color:#666;margin:10px 0;line-height:1.5">
    You received this because you subscribed to the Familiarise newsletter.
    <br/>
    <a href="${unsubscribeUrl}" style="color:#666;text-decoration:underline">Unsubscribe</a>
  </p>
</div>`;

  // Try to insert before closing body/html tags
  if (html.includes("</body>")) {
    return html.replace("</body>", `${footer}</body>`);
  }
  if (html.includes("</html>")) {
    return html.replace("</html>", `${footer}</html>`);
  }
  return html + footer;
}
