/**
 * GET /api/support/external-verify — an anonymous complainant's confirmation
 * landing. GET only renders a button; the POST records the confirmation, so a
 * mail scanner that prefetches the link cannot confirm the address itself.
 */

import * as Sentry from "@sentry/nextjs";
import { NextRequest } from "next/server";
import { z } from "zod";
import { getAppUrl } from "@/lib/url";
import { confirmExternalRequesterEmail } from "@/lib/support/external-requester";

const LinkSchema = z.object({
  case: z.string().min(1).max(64),
  issued: z.coerce.number().int().positive(),
  token: z.string().regex(/^[0-9a-f]{64}$/),
});

function escapeAttribute(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => `&#${ch.codePointAt(0)};`);
}

function page(title: string, body: string, status: number): Response {
  return new Response(
    `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex" />
    <title>${title} — Familiarise</title>
  </head>
  <body style="margin:0;background:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',sans-serif">
    <div style="max-width:520px;margin:0 auto;padding:64px 20px">
      <div style="background:#fff;border-radius:8px;padding:32px">
        <h1 style="margin:0 0 12px;font-size:24px;color:#111">${title}</h1>
        ${body}
      </div>
    </div>
  </body>
</html>`,
    {
      status,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
      },
    },
  );
}

const paragraph = (text: string) =>
  `<p style="margin:0 0 24px;font-size:16px;line-height:1.5;color:#444">${text}</p>`;

const homeLink = `<a href="${getAppUrl()}" style="display:inline-block;background:#000;color:#fff;padding:12px 20px;border-radius:5px;text-decoration:none;font-size:15px">Go to Familiarise</a>`;

const invalidLink = () =>
  page(
    "Link expired",
    paragraph(
      "This confirmation link is no longer valid. Links expire after seven days; the next update on your grievance will include a fresh one.",
    ) + homeLink,
    400,
  );

export function GET(request: NextRequest): Response {
  const link = LinkSchema.safeParse(
    Object.fromEntries(request.nextUrl.searchParams),
  );
  if (!link.success) return invalidLink();
  const hidden = (name: string, value: string | number) =>
    `<input type="hidden" name="${name}" value="${escapeAttribute(String(value))}" />`;
  return page(
    "Confirm your email",
    paragraph(
      "Confirm this address to receive our responses to your grievance by email.",
    ) +
      `<form method="post" action="/api/support/external-verify">
        ${hidden("case", link.data.case)}
        ${hidden("issued", link.data.issued)}
        ${hidden("token", link.data.token)}
        <button type="submit" style="background:#000;color:#fff;padding:12px 20px;border:0;border-radius:5px;font-size:15px;cursor:pointer">Confirm email address</button>
      </form>`,
    200,
  );
}

export async function POST(request: NextRequest): Promise<Response> {
  try {
    const form = await request.formData().catch(() => null);
    const link = LinkSchema.safeParse({
      case: form?.get("case"),
      issued: form?.get("issued"),
      token: form?.get("token"),
    });
    if (!link.success) return invalidLink();
    const outcome = await confirmExternalRequesterEmail({
      caseId: link.data.case,
      token: link.data.token,
      issuedAt: link.data.issued,
    });
    if (outcome === "INVALID") return invalidLink();
    return page(
      outcome === "VERIFIED" ? "Email confirmed" : "Already confirmed",
      paragraph(
        "Thank you. We will email our responses to your grievance to this address.",
      ) + homeLink,
      200,
    );
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "support", op: "externalVerify" } },
    );
    return page(
      "Something went wrong",
      paragraph(
        "We could not confirm your address right now. Please try the link again in a moment.",
      ) + homeLink,
      500,
    );
  }
}
