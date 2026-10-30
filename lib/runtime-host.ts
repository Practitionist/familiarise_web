/**
 * True on Netlify in every bundle: Next code sees the build-inlined `NETLIFY`,
 * `netlify/functions/*` see only the runtime `SITE_ID`. Both reads stay literal.
 */
export function onNetlify(): boolean {
  return process.env.NETLIFY === "true" || process.env.SITE_ID !== undefined;
}
