import type { NextRequest } from "next/server";
import { betterAuthTrustedOrigins } from "@/lib/auth/trusted-origins";
import { getAppUrl } from "@/lib/url";

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * The public origins this site answers on: Better Auth's trusted origins, the
 * app URL, and the host the request itself reached over https (preview aliases).
 */
function trustedOrigins(req: NextRequest): Set<string> {
  const origins = [
    ...betterAuthTrustedOrigins(),
    getAppUrl(),
    req.nextUrl.origin,
    ...[req.headers.get("x-forwarded-host"), req.headers.get("host")]
      .map((host) => host?.split(",")[0]?.trim())
      .filter((host): host is string => !!host)
      .map((host) => `https://${host}`),
  ];
  return new Set(origins.map(originOf).filter((o): o is string => o !== null));
}

/** True when the browser's Origin header names one of this site's own origins. */
export function isSameOriginRequest(req: NextRequest): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return false;
  const normalized = originOf(origin);
  return normalized !== null && trustedOrigins(req).has(normalized);
}

/**
 * True only for a JSON request this site's own page sent: a cross-site form
 * cannot send JSON without a CORS preflight, and its Origin names the other site.
 */
export function isSameOriginJsonRequest(req: NextRequest): boolean {
  const json = (req.headers.get("content-type") ?? "").startsWith(
    "application/json",
  );
  return json && isSameOriginRequest(req);
}
