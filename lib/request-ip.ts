// Middleware overwrites this on every request it forwards and Node code trusts only it;
// safe because the middleware matcher covers every path that reads it.
export const CLIENT_IP_HEADER = "x-familiarise-client-ip";

type IpHeaders = { get(name: string): string | null };

/** Host markers, read literally so a build that inlines them can replace them. */
export type EdgeHost = { VERCEL?: string; FLY_APP_NAME?: string };

const hops = (value: string | null): string[] =>
  (value ?? "")
    .split(",")
    .map((hop) => hop.trim())
    .filter(Boolean);

/** The visitor's IP as edge middleware sees it on this host, or `unknown_ip`. */
export function edgeClientIp(
  headers: IpHeaders,
  host: EdgeHost = {
    VERCEL: process.env.VERCEL,
    FLY_APP_NAME: process.env.FLY_APP_NAME,
  },
): string {
  if (host.VERCEL === "1") {
    return hops(headers.get("x-vercel-forwarded-for"))[0] || "unknown_ip";
  }
  if (host.FLY_APP_NAME) {
    return hops(headers.get("fly-client-ip"))[0] || "unknown_ip";
  }
  // Netlify's edge sets no client-IP header (docs.netlify.com/build/edge-functions/api);
  // its proxy, like a generic one, appends the real peer as the last hop.
  return hops(headers.get("x-forwarded-for")).at(-1) || "unknown_ip";
}

/** The client IP middleware stamped on this request, or `unknown_ip`. */
export function stampedClientIp(headers: IpHeaders): string {
  return headers.get(CLIENT_IP_HEADER)?.trim() || "unknown_ip";
}
