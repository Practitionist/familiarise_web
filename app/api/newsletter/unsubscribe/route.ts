/**
 * GET/POST /api/newsletter/unsubscribe?email=...&token=...
 *
 * Handles newsletter unsubscription via signed link.
 * GET: Standard unsubscribe via email link click.
 * POST: RFC 8058 one-click unsubscribe (List-Unsubscribe-Post header).
 *
 * Security:
 * - HMAC-SHA256 token verification (constant-time comparison)
 * - Always returns same HTML regardless of subscriber existence (prevents enumeration)
 */

import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getAppUrl } from "@/lib/url";
import { verifyUnsubscribeToken } from "@/lib/newsletter/unsubscribe";

async function handleUnsubscribe(
  email: string | null,
  token: string | null,
): Promise<NextResponse> {
  if (!email || !token) {
    return NextResponse.json(
      { error: "Missing email or token" },
      { status: 400 },
    );
  }

  // Constant-time HMAC verification
  if (!verifyUnsubscribeToken(email, token)) {
    return NextResponse.json(
      { error: "Invalid unsubscribe link" },
      { status: 403 },
    );
  }

  // Attempt unsubscribe — always return same confirmation to prevent enumeration
  try {
    await prisma.newsletter.update({
      where: { email },
      data: { unsubscribed: true, unsubscribedAt: new Date() },
    });
  } catch {
    // Record doesn't exist or already unsubscribed — same response either way
  }

  return new NextResponse(unsubscribeHtml(email), {
    headers: { "Content-Type": "text/html" },
  });
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const { searchParams } = new URL(req.url);
    return handleUnsubscribe(
      searchParams.get("email"),
      searchParams.get("token"),
    );
  } catch (error) {
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "newsletter" } });
    console.error("[newsletter/unsubscribe] Error:", error);
    return NextResponse.json(
      { error: "Failed to unsubscribe. Please try again." },
      { status: 500 },
    );
  }
}

/**
 * POST handler for RFC 8058 one-click unsubscribe.
 * Email clients send: POST with body "List-Unsubscribe=One-Click"
 * The email and token come from query params (same URL as GET).
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const { searchParams } = new URL(req.url);
    return handleUnsubscribe(
      searchParams.get("email"),
      searchParams.get("token"),
    );
  } catch (error) {
    console.error("[newsletter/unsubscribe] POST Error:", error);
    return NextResponse.json(
      { error: "Failed to unsubscribe." },
      { status: 500 },
    );
  }
}

function unsubscribeHtml(email: string): string {
  const baseUrl = getAppUrl();
  return `<!DOCTYPE html>
<html>
<head><title>Unsubscribed — Familiarise</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f5f5f5; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; }
  .card { background: #fff; padding: 40px; border-radius: 8px; max-width: 480px; text-align: center; }
  h1 { color: #333; font-size: 24px; margin-bottom: 16px; }
  p { color: #666; font-size: 16px; line-height: 1.5; }
  a { color: #000; text-decoration: underline; }
</style>
</head>
<body>
<div class="card">
  <h1>Successfully Unsubscribed</h1>
  <p><strong>${email}</strong> has been removed from our newsletter. You won't receive any more marketing emails from us.</p>
  <p><a href="${baseUrl}">Return to Familiarise</a></p>
</div>
</body>
</html>`;
}
