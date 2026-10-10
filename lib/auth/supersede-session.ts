import type { BetterAuthPlugin } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";
import prisma from "@/lib/prisma";
import { revokeSessionByToken } from "@/lib/auth/session-revoke";

/**
 * When a request that arrived with a session cookie leaves with a different
 * session (signing in over an existing one, by any method), the overwritten
 * row is revoked instead of lingering as a ghost device. Registered after
 * `twoFactor()`, which clears `newSession` while a challenge is pending.
 */
export const supersededSessionRevocation = {
  id: "superseded-session-revocation",
  hooks: {
    after: [
      {
        matcher: () => true,
        handler: createAuthMiddleware(async (ctx) => {
          const issued = ctx.context.newSession?.session.token;
          if (!issued) return;
          const previous = await ctx.getSignedCookie(
            ctx.context.authCookies.sessionToken.name,
            ctx.context.secret,
          );
          if (!previous || previous === issued) return;
          await revokeSessionByToken(prisma, previous);
        }),
      },
    ],
  },
} satisfies BetterAuthPlugin;
