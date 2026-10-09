import type { AuthHookContext } from "@/lib/auth/security-event-hook";

const ISSUES_SESSION =
  /^\/(sign-in|sign-up|change-password|two-factor\/verify-|passkey\/verify-authentication)/;

/**
 * `hooks.after`: sign-in, sign-up, change-password, two-factor verify and
 * passkey sign-in put the new session's token (the cookie's bearer value) in
 * their JSON, top-level or under `session`. The browser only needs the cookie,
 * so the body loses it; Set-Cookie is untouched.
 */
export async function stripSessionToken(ctx: AuthHookContext) {
  const returned = ctx.context.returned;
  if (
    !ISSUES_SESSION.test(ctx.path ?? "") ||
    !returned ||
    typeof returned !== "object"
  ) {
    return;
  }
  const session = "session" in returned ? returned.session : undefined;
  const nested =
    session && typeof session === "object" && "token" in session
      ? session
      : null;
  if (!("token" in returned) && !nested) return;
  const body: Record<string, unknown> = { ...returned };
  delete body.token;
  if (nested) {
    const withoutToken: Record<string, unknown> = { ...nested };
    delete withoutToken.token;
    body.session = withoutToken;
  }
  return ctx.json(body);
}
