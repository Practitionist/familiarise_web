/**
 * GET /api/newsletter/unsubscribe?email=...&token=...
 *
 * Handles newsletter unsubscription via signed link.
 * Token is an HMAC-SHA256 of the email using NEWSLETTER_HMAC_SECRET.
 * This prevents unauthorized unsubscribes.
 */

import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getAppUrl } from "@/lib/url";
import { generateUnsubscribeToken } from "@/lib/newsletter/unsubscribe";

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const { searchParams } = new URL(req.url);
    const email = searchParams.get("email");
    const token = searchParams.get("token");

    if (!email || !token) {
      return NextResponse.json(
        { error: "Missing email or token" },
        { status: 400 },
      );
    }

    // Verify HMAC token
    const expectedToken = generateUnsubscribeToken(email);
    if (token !== expectedToken) {
      return NextResponse.json(
        { error: "Invalid unsubscribe link" },
        { status: 403 },
      );
    }

    // Update newsletter record
    const subscriber = await prisma.newsletter.findUnique({
      where: { email },
    });

    if (!subscriber) {
      return NextResponse.json({ error: "Email not found" }, { status: 404 });
    }

    if (subscriber.unsubscribed) {
      // Already unsubscribed — show confirmation page
      return new NextResponse(unsubscribeHtml(email, true), {
        headers: { "Content-Type": "text/html" },
      });
    }

    await prisma.newsletter.update({
      where: { email },
      data: { unsubscribed: true, unsubscribedAt: new Date() },
    });

    // Stub: Remove from ConvertKit (Issue #334)
    // await removeFromConvertKit(email);

    return new NextResponse(unsubscribeHtml(email, false), {
      headers: { "Content-Type": "text/html" },
    });
  } catch (error) {
    console.error("[newsletter/unsubscribe] Error:", error);
    return NextResponse.json(
      { error: "Failed to unsubscribe. Please try again." },
      { status: 500 },
    );
  }
}

function unsubscribeHtml(email: string, alreadyUnsubscribed: boolean): string {
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
  <h1>${alreadyUnsubscribed ? "Already Unsubscribed" : "Successfully Unsubscribed"}</h1>
  <p>${alreadyUnsubscribed ? `<strong>${email}</strong> was already unsubscribed from our newsletter.` : `<strong>${email}</strong> has been removed from our newsletter. You won't receive any more marketing emails from us.`}</p>
  <p><a href="${baseUrl}">Return to Familiarise</a></p>
</div>
</body>
</html>`;
}
