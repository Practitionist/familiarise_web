import type { NextRequest } from "next/server";

/**
 * True only for a JSON request this site's own page sent: a cross-site form
 * cannot send JSON without a CORS preflight, and its Origin names the other site.
 */
export function isSameOriginJsonRequest(req: NextRequest): boolean {
  const origin = req.headers.get("origin");
  const json = (req.headers.get("content-type") ?? "").startsWith(
    "application/json",
  );
  return json && origin !== null && origin === req.nextUrl.origin;
}
