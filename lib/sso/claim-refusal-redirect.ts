import { isAPIError } from "better-auth/api";
import { z } from "zod";
import type { AuthHookContext } from "@/lib/auth/security-event-hook";

const ClaimRefusalCodeSchema = z.enum([
  "SSO_ID_TOKEN_MISSING",
  "SSO_EMAIL_NOT_VERIFIED",
  "SSO_HOSTED_DOMAIN_MISMATCH",
  "SSO_ACCOUNT_ALREADY_LINKED",
]);

/**
 * `hooks.after`: @better-auth/sso calls `provisionUser` outside its own error
 * redirect, so a claim refusal thrown there would answer raw JSON. Returns the
 * redirect back to sign-in with the code, like the plugin's own refusals.
 */
export function ssoClaimRefusalRedirect(
  ctx: AuthHookContext,
): Response | undefined {
  if (!ctx.path?.startsWith("/sso/callback")) return undefined;
  const returned = ctx.context.returned;
  if (!isAPIError(returned)) return undefined;
  const code = ClaimRefusalCodeSchema.safeParse(returned.body?.code);
  if (!code.success) return undefined;
  // A thrown ctx.redirect() would keep the refusal's 403 status; a Response replaces it.
  return new Response(null, {
    status: 302,
    headers: { Location: `/auth/signin?error=${code.data}` },
  });
}
