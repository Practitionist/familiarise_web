/**
 * Unsubscribe from the newsletter.
 *
 * GET  — the link in an email footer, answers with an HTML confirmation page.
 * POST — RFC 8058 one-click, used by Gmail/Outlook's native unsubscribe button
 *        via the List-Unsubscribe-Post header. Must not require a click-through
 *        or a session.
 *
 * Both are enumeration-safe: the response is identical whether the address was
 * on the list or not. A failed write never answers "unsubscribed". The page is
 * bare: the text wordmark only, with no site navigation or newsletter sign-up.
 */

import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import { BRAND_COLOR_HEX, BRAND_NAME } from "@/lib/brand";
import { goHref } from "@/lib/dashboard/go";
import { unsubscribe } from "@/lib/newsletter/service";
import { getAppUrl } from "@/lib/url";

export function GET(request: NextRequest): Response {
  const { searchParams } = new URL(request.url);
  const email = searchParams.get("email");
  const token = searchParams.get("token");

  if (!email || !token) {
    return html(
      "Link incomplete",
      `That unsubscribe link is missing information. ${SETTINGS_FALLBACK}`,
      400,
      SETTINGS_ACTION,
    );
  }

  const actionUrl = `${getAppUrl()}/api/newsletter/unsubscribe?email=${encodeURIComponent(
    email,
  )}&token=${encodeURIComponent(token)}`;
  return html(
    "Confirm unsubscribe",
    "Click below to stop receiving newsletters from Familiarise.",
    200,
    { post: actionUrl },
  );
}

export async function POST(request: NextRequest): Promise<Response> {
  const { searchParams } = new URL(request.url);
  const email = searchParams.get("email");
  const token = searchParams.get("token");

  let outcome: "unsubscribed" | "invalid" | "failed" = "invalid";
  if (email && token) {
    try {
      outcome = (await unsubscribe({ email, token })).ok
        ? "unsubscribed"
        : "invalid";
    } catch (error) {
      outcome = "failed";
      Sentry.captureException(
        error instanceof Error ? error : new Error(String(error)),
        { tags: { subsystem: "newsletter" } },
      );
      console.error("[newsletter/unsubscribe:one-click]", error);
    }
  }

  const page = OUTCOME_PAGES[outcome];
  if (request.headers.get("accept")?.includes("text/html")) {
    return html(
      page.title,
      page.body,
      page.status,
      outcome === "invalid" ? SETTINGS_ACTION : undefined,
    );
  }

  return NextResponse.json(
    { success: outcome === "unsubscribed" },
    { status: page.status },
  );
}

/** Signing keys rotate with the auth secret, so an old link can stop verifying. */
const SETTINGS_FALLBACK =
  "If you have an account, sign in and turn off marketing email in your account settings. Otherwise reply to any of our emails and we will remove you by hand.";

const SETTINGS_ACTION = {
  href: goHref("auto", "settings/account"),
  label: "Open account settings",
};

const OUTCOME_PAGES = {
  unsubscribed: {
    status: 200,
    title: "You are unsubscribed",
    body: "You will not receive any more newsletters from Familiarise. Changed your mind? You can sign up again from any page on the site.",
  },
  invalid: {
    status: 400,
    title: "This link is not valid",
    body: `That unsubscribe link is incomplete, has been changed or has expired. ${SETTINGS_FALLBACK}`,
  },
  failed: {
    status: 500,
    title: "We could not unsubscribe you",
    body: "Nothing was changed. Please try the link again in a few minutes.",
  },
} as const;

function html(
  title: string,
  body: string,
  status: number,
  action?: { post: string } | { href: string; label: string },
): Response {
  const link = (href: string, label: string) =>
    `<a href="${href}" style="display:inline-block;background:#000;color:#fff;padding:12px 20px;border-radius:5px;text-decoration:none;font-size:15px">${label}</a>`;
  let cta = link(getAppUrl(), "Go to Familiarise");
  if (action && "post" in action) {
    cta = `<form method="post" action="${action.post}" style="margin:0"><button type="submit" style="cursor:pointer;border:0;background:#000;color:#fff;padding:12px 20px;border-radius:5px;font-size:15px">Unsubscribe</button></form>`;
  } else if (action) {
    cta = link(`${getAppUrl()}${action.href}`, action.label);
  }
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
      <p translate="no" style="margin:0 0 24px;text-align:center;font-size:28px;font-weight:600;line-height:1.1;letter-spacing:-0.02em;color:${BRAND_COLOR_HEX}">${BRAND_NAME}</p>
      <div style="background:#fff;border-radius:8px;padding:32px">
        <h1 style="margin:0 0 12px;font-size:24px;color:#111">${title}</h1>
        <p style="margin:0 0 24px;font-size:16px;line-height:1.5;color:#444">${body}</p>
        ${cta}
      </div>
    </div>
  </body>
</html>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}
