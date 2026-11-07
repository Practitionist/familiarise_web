import { NextResponse } from "next/server";

import { MAX_BODY_BYTES } from "./input-limits";

/**
 * Reject oversized request bodies before parsing (#831).
 * Returns a 413 NextResponse when content-length exceeds the cap, else null.
 * Content-length is attacker-suppliable but Netlify enforces it on the
 * function payload, so a lying header still cannot smuggle a larger body.
 */
export function assertBodySize(
  req: { headers: { get(name: string): string | null } },
  maxBytes: number = MAX_BODY_BYTES,
): NextResponse | null {
  const len = Number(req.headers.get("content-length") ?? 0);
  if (Number.isFinite(len) && len > maxBytes) {
    return NextResponse.json(
      { error: "Request body too large" },
      { status: 413 },
    );
  }
  return null;
}
