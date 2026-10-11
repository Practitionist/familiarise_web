/**
 * POST /api/webhooks/directus
 *
 * Placeholder for Directus CMS webhook handler. Disabled unless DIRECTUS_WEBHOOK_SECRET is configured.
 */

import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import {
  MAX_WEBHOOK_BODY_BYTES,
  readBodyWithinCap,
} from "@/lib/webhooks/read-body";

export const runtime = "nodejs";

const directusWebhookSchema = z
  .object({
    collection: z.string().optional(),
    event: z.string().optional(),
    keys: z.array(z.union([z.string(), z.number()])).optional(),
    key: z.union([z.string(), z.number()]).optional(),
  })
  .passthrough();

/** Constant-time compare; timingSafeEqual throws on unequal lengths. */
function secretMatches(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const secret = process.env.DIRECTUS_WEBHOOK_SECRET;

  if (!secret) {
    return NextResponse.json({ error: "Not Found" }, { status: 404 });
  }

  const declaredBytes = Number(req.headers.get("content-length"));
  if (
    Number.isFinite(declaredBytes) &&
    declaredBytes > MAX_WEBHOOK_BODY_BYTES
  ) {
    return NextResponse.json({ error: "Payload too large" }, { status: 413 });
  }

  const signature = req.headers.get("x-directus-signature");
  if (!signature || !secretMatches(signature, secret)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const rawBody = await readBodyWithinCap(req);
  if (rawBody === null) {
    return NextResponse.json({ error: "Payload too large" }, { status: 413 });
  }
  if (!rawBody) {
    return NextResponse.json({ error: "Empty body" }, { status: 400 });
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = directusWebhookSchema.safeParse(parsedJson);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid webhook payload" },
      { status: 400 },
    );
  }

  console.log("[webhooks/directus] Received webhook event:", {
    collection: parsed.data.collection,
    event: parsed.data.event,
    keys: parsed.data.keys,
  });

  return NextResponse.json({
    received: true,
    message: "CMS integration not yet active",
  });
}
