/**
 * POST /api/webhooks/directus
 *
 * Placeholder for Directus CMS webhook handler.
 * When Directus is integrated (Issue #312), this will:
 * 1. Receive `items.create` events for `cms_posts`
 * 2. Call ConvertKit to create a broadcast with the new blog post
 * 3. Optionally invalidate ISR/cache for the blog pages
 *
 * Not yet active — returns 200 with a message.
 */

import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const body = await req.json();

    console.log("[webhooks/directus] Received webhook event:", {
      collection: body?.collection,
      event: body?.event,
      keys: body?.keys,
    });

    // TODO: Issue #312 — Implement Directus webhook handling
    // 1. Validate webhook signature (X-Directus-Signature header)
    // 2. Check event type (items.create on cms_posts)
    // 3. Fetch post data from Directus API
    // 4. Call createBroadcast() from lib/newsletter/convertkit.ts
    // 5. Invalidate blog page cache

    return NextResponse.json({
      received: true,
      message: "CMS integration not yet active",
    });
  } catch (error) {
    console.error("[webhooks/directus] Error:", error);
    return NextResponse.json(
      { error: "Webhook processing failed" },
      { status: 500 },
    );
  }
}
