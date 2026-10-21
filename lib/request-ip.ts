/**
 * Client IP headers trusted on the current runtime. Each platform header is
 * honoured only where that platform sets it; elsewhere a client can forge it.
 */
export type ClientIpHeader =
  | "x-nf-client-connection-ip"
  | "x-vercel-forwarded-for"
  | "fly-client-ip"
  | "x-forwarded-for";

/** The runtime environment, where each host sets its platform marker. */
export type RuntimeEnv = Readonly<Record<string, string | undefined>>;

export function trustedClientIpHeaders(
  env: RuntimeEnv = process.env,
): ClientIpHeader[] {
  if (env.NETLIFY === "true") return ["x-nf-client-connection-ip"];
  if (env.VERCEL === "1") return ["x-vercel-forwarded-for"];
  if (env.FLY_APP_NAME) return ["fly-client-ip"];
  return ["x-forwarded-for"];
}

/**
 * The caller's IP on this runtime, or `unknown_ip`. A generic container host
 * trusts only the rightmost `x-forwarded-for` hop, which its front end appends.
 */
export function clientIpFrom(
  headers: { get(name: string): string | null },
  env: RuntimeEnv = process.env,
): string {
  const [header] = trustedClientIpHeaders(env);
  const hops = (headers.get(header) ?? "")
    .split(",")
    .map((hop) => hop.trim())
    .filter(Boolean);
  const ip = header === "x-forwarded-for" ? hops.at(-1) : hops[0];
  return ip || "unknown_ip";
}
