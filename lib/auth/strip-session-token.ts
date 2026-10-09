import { createAuthMiddleware } from "better-auth/api";

const ISSUES_SESSION =
  /^\/(sign-in|sign-up|change-password|two-factor\/verify-)/;

/**
 * `hooks.after`: sign-in, sign-up, change-password and two-factor verify put
 * the new session's token (the cookie's bearer value) in their JSON. The
 * browser only needs the cookie, so the body loses `token`; Set-Cookie is
 * untouched.
 */
export const stripSessionToken = createAuthMiddleware(async (ctx) => {
  const returned = ctx.context.returned;
  if (
    !ISSUES_SESSION.test(ctx.path ?? "") ||
    !returned ||
    typeof returned !== "object" ||
    !("token" in returned)
  ) {
    return;
  }
  const body: Record<string, unknown> = { ...returned };
  delete body.token;
  return ctx.json(body);
});
