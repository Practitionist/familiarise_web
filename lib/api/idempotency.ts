/**
 * Request-level idempotency for money mutations.
 *
 * `/api/checkout` and org wallet top-ups already dedupe on a client-minted key
 * that lands in a unique column (`Payment.clientIdempotencyKey`,
 * `WalletTopUp.providerOrderId`).
 *
 * The gateway idempotency headers (`X-Refund-Idempotency`,
 * `X-Payout-Idempotency`) stop a duplicate reaching the bank, but they are
 * keyed off rows we create first — so a duplicate REQUEST still creates a
 * second row with a second gateway key, and the gateway honours both. This
 * closes that gap one layer earlier.
 *
 * Where it is actually mounted, and where it is not:
 *
 *   - `/api/admin/refunds` does NOT use it: the door requires the
 *     `Idempotency-Key` header and turns it into `Refund.dedupeKey`.
 *   - Admin payout processing does NOT use it and does not need it — a Redis
 *     lock plus a per-payout APPROVED->PROCESSING CAS already make it
 *     exactly-once.
 *   - Org payout creation does NOT use it: `createOrgPayoutBatch` derives a
 *     deterministic key from (organizationId, periodStart) with a unique
 *     constraint and a P2002 re-read.
 *   - Invoice pay does NOT use it: it reuses `providerPaymentOrderId`.
 *   - The overage order route does NOT use it; it was genuinely unprotected and
 *     was fixed in kind (reuse the unpaid order, refuse when one is in flight,
 *     CAS the stamp) because the right key there is the order itself.
 *
 * Usage — note the `await`, which is load-bearing whenever the call sits inside
 * a `try`. `return somePromise` hands the promise to the caller before it
 * settles, so a rejection bypasses the enclosing catch and surfaces as Next's
 * bare 500-with-empty-body instead of the route's typed error mapping:
 *
 *   return await withIdempotency(req, { scope: "admin.refund", userId }, async () => {
 *     ...do the work...
 *     return NextResponse.json({ refundId });
 *   });
 *
 * When the caller sends no `Idempotency-Key` the handler runs unchanged, so
 * this is additive for every existing client.
 */
import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";

import prisma from "@/lib/prisma";

/** How long a key is honoured. Longer than any sane client retry window. */
const TTL_MS = 24 * 60 * 60 * 1000;

/** Razorpay's own minimum; applying it here keeps the two layers consistent. */
const MIN_KEY_LENGTH = 10;
const MAX_KEY_LENGTH = 255;

/** One retry of the claim when the key changes hands under a request. */
const CLAIM_ATTEMPTS = 2;

/** A held key: its identity and the instant this request claimed it. */
type Claim = { scope: string; key: string; userId: string; createdAt: Date };

export type IdempotencyOptions = {
  /** Route-owned namespace, e.g. "admin.refund". Must be stable. */
  scope: string;
  /** Authenticated caller. Keys never cross users. */
  userId: string;
};

function hashBody(body: string): string {
  return crypto.createHash("sha256").update(body).digest("hex");
}

/**
 * Wrap a money mutation so a repeated `Idempotency-Key` replays the original
 * response instead of doing the work twice.
 *
 * The handler receives the parsed body so the caller does not have to read the
 * request stream twice (a `Request` body can only be consumed once).
 */
export async function withIdempotency(
  req: NextRequest,
  opts: IdempotencyOptions,
  handler: (body: unknown) => Promise<NextResponse>,
): Promise<NextResponse> {
  const rawBody = await req.text();
  let parsedBody: unknown = undefined;
  if (rawBody.length > 0) {
    try {
      parsedBody = JSON.parse(rawBody);
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }
  }

  const key = req.headers.get("Idempotency-Key")?.trim();

  // No key supplied — behave exactly as before. Making the header mandatory
  // would break every existing client, and a route with no key is no worse off
  // than it is today.
  if (!key) {
    return handler(parsedBody);
  }

  if (key.length < MIN_KEY_LENGTH || key.length > MAX_KEY_LENGTH) {
    return NextResponse.json(
      {
        error: `Idempotency-Key must be between ${MIN_KEY_LENGTH} and ${MAX_KEY_LENGTH} characters`,
      },
      { status: 400 },
    );
  }

  const requestHash = hashBody(rawBody);
  const identity = { scope: opts.scope, key, userId: opts.userId };

  for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt++) {
    const now = new Date();
    const claim: Claim = { ...identity, createdAt: now };
    const expiresAt = new Date(now.getTime() + TTL_MS);

    // Claim the key. The unique index is the race guard: of two concurrent
    // requests with one key, exactly one insert lands.
    try {
      await prisma.idempotencyRecord.create({
        data: { ...claim, requestHash, expiresAt },
      });
      return runAndRecord(handler, parsedBody, claim);
    } catch (err) {
      if (
        typeof err !== "object" ||
        err === null ||
        (err as { code?: string }).code !== "P2002"
      ) {
        throw err;
      }
    }

    const existing = await prisma.idempotencyRecord.findUnique({
      where: { scope_key_userId: identity },
    });

    // Gone between the refused insert and the read (a sweep, or its holder
    // freed it): claim it again rather than run without a claim.
    if (!existing) continue;

    // An expired claim is taken over by one conditional write that repeats the
    // expiry this request read; a retry that lost the takeover answers from
    // the winner's claim on the next pass.
    if (existing.expiresAt <= now) {
      const taken = await prisma.idempotencyRecord.updateMany({
        where: { ...identity, expiresAt: existing.expiresAt },
        data: {
          requestHash,
          responseBody: Prisma.JsonNull,
          responseStatus: null,
          completedAt: null,
          createdAt: now,
          expiresAt,
        },
      });
      if (taken.count === 1) return runAndRecord(handler, parsedBody, claim);
      continue;
    }

    // Same key, different body. This is a client bug — replaying the original
    // response would be actively misleading (the caller asked for something
    // else and would think it succeeded).
    if (existing.requestHash !== requestHash) {
      return NextResponse.json(
        {
          error:
            "Idempotency-Key was already used with a different request body",
          code: "IDEMPOTENCY_KEY_REUSED",
        },
        { status: 422 },
      );
    }

    // Still in flight. Racing it would defeat the point; tell the caller to
    // retry rather than doing the work twice.
    if (!existing.completedAt) return inFlightResponse();

    // Genuine retry — replay the original outcome verbatim.
    return NextResponse.json(existing.responseBody ?? {}, {
      status: existing.responseStatus ?? 200,
      headers: { "Idempotent-Replay": "true" },
    });
  }

  // The key changed hands on every pass: another request holds it now.
  return inFlightResponse();
}

function inFlightResponse(): NextResponse {
  return NextResponse.json(
    {
      error:
        "Your earlier request is still being processed. Wait a moment, then refresh the page to see it.",
      code: "IDEMPOTENCY_IN_FLIGHT",
    },
    { status: 409 },
  );
}

/**
 * Run the handler and settle its claim. Every write is fenced by the claim's
 * own creation instant, so a handler that finishes after its key passed to a
 * newer request neither overwrites nor frees the newer receipt.
 *
 * A 2xx is stored for replay. A non-2xx or a thrown handler frees the key, so
 * the caller can retry after fixing the cause; the doors behind this wrapper
 * guard their own writes, so a retry cannot apply twice. A process that dies
 * mid-handler frees nothing: its claim stays in flight until it expires, and a
 * retry inside that time is answered 409.
 */
async function runAndRecord(
  handler: (body: unknown) => Promise<NextResponse>,
  body: unknown,
  claim: Claim,
): Promise<NextResponse> {
  const free = () =>
    prisma.idempotencyRecord.deleteMany({ where: claim }).catch(() => {});

  let response: NextResponse;
  try {
    response = await handler(body);
  } catch (err) {
    await free();
    throw err;
  }

  // Only successful responses are replayable. Recording a 4xx/5xx would pin the
  // caller to a failure they are entitled to retry out of.
  if (response.status >= 200 && response.status < 300) {
    let responseBody: unknown = null;
    try {
      responseBody = await response.clone().json();
    } catch {
      responseBody = null;
    }
    await prisma.idempotencyRecord.updateMany({
      where: claim,
      data: {
        completedAt: new Date(),
        responseStatus: response.status,
        responseBody: responseBody as never,
      },
    });
  } else {
    await free();
  }

  return response;
}
