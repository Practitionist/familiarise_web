import * as Sentry from "@sentry/nextjs";
import { betterAuth } from "better-auth";
import {
  APIError,
  createAuthMiddleware,
  getSessionFromCtx,
} from "better-auth/api";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { nextCookies } from "better-auth/next-js";
import { admin, customSession, twoFactor } from "better-auth/plugins";
import { adminAc, userAc, defaultAc } from "better-auth/plugins/admin/access";
import { sso } from "@better-auth/sso";
import bcrypt from "bcrypt";
import prisma from "@/lib/prisma";
import {
  sendWelcomeEmail,
  sendAccountLinkedEmail,
  sendPasswordResetEmail,
  sendVerificationEmail,
} from "@/lib/email";
import { syncSubscriber } from "@/lib/novu/subscriber";
import {
  shouldRejectSession,
  lookupEnforcedOrg,
} from "@/lib/sso/enforce-session";
import { ssoPluginOptions } from "@/lib/sso/plugin-options";
import {
  assertSsoEmailOnDomain,
  isSsoProviderId,
} from "@/lib/sso/account-domain";
import { buildSignupConsentArtifacts } from "@/lib/compliance/dpdp";
import { reportAuthLogToSentry } from "@/lib/auth/auth-logger";
import {
  capOperatorExpiry,
  isOperatorRole,
  refusesOperatorAccount,
  refusesOperatorSession,
} from "@/lib/auth/operator-session-policy";
import { breachedPasswordCheck } from "@/lib/auth/password-policy";
import { authRateLimit } from "@/lib/auth/rate-limit";
import { stripSessionToken } from "@/lib/auth/strip-session-token";
import { revokeAllUserSessions } from "@/lib/auth/session-revoke";
import {
  assertOperatorMayEnableTwoFactor,
  isTwoFactorEnrolment,
} from "@/lib/auth/two-factor-policy";
import {
  isSentryIdentityEnabled,
  resolveSentryUserId,
} from "@/lib/observability/identity";

// STAFF = moderator: read users (a subset of the full admin AC). Shares
// defaultAc so statements line up. No `session:*`: the plugin's session
// endpoints return raw tokens, and staff revoke goes through
// app/api/admin/users/[userId]/sessions/revoke instead.
//
// #1132 — `set-role` and `ban` are deliberately NOT granted here. The admin
// plugin's /admin/set-role authorises on the caller's `user:["set-role"]`
// permission alone and never compares actor rank to target rank, so holding it
// let STAFF assign themselves ADMIN — which lib/auth-helpers.ts then treats as
// OWNER on every organization. This mirrors BACKOFFICE_PERMISSIONS, where
// `users.moderate` is ADMIN_ONLY. Ban writes already go through lib/moderation
// via Prisma rather than auth.api.banUser, so nothing legitimate needed it.
const staffAc = defaultAc.newRole({
  user: ["list", "get"],
});

export const auth = betterAuth({
  secret: process.env.BETTER_AUTH_SECRET,
  baseURL: process.env.BETTER_AUTH_URL,
  trustedOrigins: process.env.BETTER_AUTH_TRUSTED_ORIGINS
    ? process.env.BETTER_AUTH_TRUSTED_ORIGINS.split(",")
    : [],

  // #1856 — BetterAuth swallows endpoint exceptions into 500 responses
  // (nothing ever throws out of `app/api/auth/[...all]`), and schema
  // errors take a message-only log branch. Without this, an auth-wide
  // outage is invisible: it lands on console (Netlify function logs)
  // and never reaches Sentry. Only `error` forwards; every level keeps
  // its console behavior — see `lib/auth/auth-logger.ts`.
  logger: {
    log: reportAuthLogToSentry,
  },

  // Endpoints that return raw session tokens (bearer credentials for the
  // whole account) or bypass the app's audited revoke path. Every session
  // list and revoke in the app goes through lib/auth/session-select.ts and
  // lib/auth/session-revoke.ts instead. Blocks HTTP only; `auth.api.*`
  // server calls are unaffected.
  disabledPaths: [
    "/list-sessions",
    "/revoke-session",
    "/revoke-sessions",
    "/revoke-other-sessions",
    // No caller: these hand out the linked provider's OAuth tokens or let the
    // browser write session fields.
    "/get-access-token",
    "/account-info",
    "/refresh-token",
    "/update-session",
    // Email/SMS OTP is not configured; operators use TOTP or backup codes.
    "/two-factor/send-otp",
    "/two-factor/verify-otp",
    // Session + password would return the TOTP secret, letting a session thief
    // clone the authenticator. Enrolment shows the URI from /two-factor/enable.
    "/two-factor/get-totp-uri",
    // The admin plugin's whole HTTP surface. It stays installed for the
    // role/ban columns, the sign-in ban check and the server-side
    // `auth.api.createUser` used by staff onboarding, but its endpoints skip
    // the back-office permission matrix, the 2FA gate and OpsActionLog. Every
    // operator action has an audited door under app/api/admin instead.
    // Impersonation is off: support reads a customer's data through the
    // back office, it does not become the customer.
    "/admin/set-role",
    "/admin/get-user",
    "/admin/create-user",
    "/admin/update-user",
    "/admin/list-users",
    "/admin/list-user-sessions",
    "/admin/unban-user",
    "/admin/ban-user",
    "/admin/impersonate-user",
    "/admin/stop-impersonating",
    "/admin/revoke-user-session",
    "/admin/revoke-user-sessions",
    "/admin/remove-user",
    "/admin/set-user-password",
    "/admin/has-permission",
    // SSO provider lifecycle. Registration, edits and deletes go through
    // app/api/organizations/[orgId]/sso/providers (org-scoped, audited,
    // server-generated providerId), and approval through the ADMIN door
    // under app/api/admin/organizations. Without the organization plugin the
    // plugin's own endpoints authorize on `provider.userId`, which our
    // org-scoped rows leave null, and its verify-domain endpoint would flip
    // `domainVerified` without staff approval.
    "/sso/register",
    "/sso/providers",
    "/sso/get-provider",
    "/sso/update-provider",
    "/sso/delete-provider",
    "/sso/request-domain-verification",
    "/sso/verify-domain",
    "/sso/saml2/sp/metadata",
    // The shared callback only serves providers with `redirectURI` set; ours
    // all return to /sso/callback/:providerId, which enforcement keys on.
    "/sso/callback",
  ],

  // SSO is OIDC-only, but @better-auth/sso 1.7.6 has no switch to leave the
  // SAML endpoints unmounted, and `disabledPaths` matches concrete paths so
  // it cannot cover the `:providerId` ones. `ctx.path` here is the route
  // template, so one prefix check 404s the whole SAML surface.
  hooks: {
    before: createAuthMiddleware(async (ctx) => {
      if (ctx.path?.startsWith("/sso/saml2")) {
        throw new APIError("NOT_FOUND");
      }
      // sign-in/sso resolves `organizationSlug` through the organization
      // plugin's model, which is not mounted, so the adapter would throw a
      // 500 (and an auth-error Sentry event) on a junk parameter. Our client
      // signs in by providerId or email only.
      if (ctx.path === "/sign-in/sso" && ctx.body?.organizationSlug) {
        throw new APIError("BAD_REQUEST", {
          message: "organizationSlug is not supported",
        });
      }
      // Only operators use 2FA, and a trusted device would let a stolen
      // password skip the authenticator for 30 days. The UI never offers it.
      if (
        (ctx.path === "/two-factor/verify-totp" ||
          ctx.path === "/two-factor/verify-backup-code") &&
        ctx.body?.trustDevice
      ) {
        throw new APIError("BAD_REQUEST", {
          message: "Trusted devices are not available.",
          code: "TRUST_DEVICE_DISABLED",
        });
      }
      await assertOperatorMayEnableTwoFactor(ctx);
      // 2FA is mandatory for operators. Recovery from a lost authenticator is
      // a backup code or an admin reset (app/api/admin/team/members/[userId]/
      // two-factor), never self-service removal.
      if (ctx.path === "/two-factor/disable") {
        const current = await getSessionFromCtx(ctx);
        if (isOperatorRole((current?.user as { role?: string })?.role)) {
          throw new APIError("FORBIDDEN", {
            message: "Two-factor authentication is required for staff.",
            code: "TWO_FACTOR_REQUIRED",
          });
        }
      }
    }),
    after: stripSessionToken,
  },

  database: prismaAdapter(prisma, {
    provider: "postgresql",
  }),

  // #1487 / #1878 — Two-layer rate-limiting architecture:
  // 1. BetterAuth endpoints (`/api/auth/*`) use `authRateLimit` (lib/auth/rate-limit.ts),
  //    backed by shared Upstash Redis via customStorage so counters persist across
  //    serverless function instances instead of resetting per cold start.
  // 2. Non-BetterAuth routes use Edge (`middleware.ts`) and route-level (`lib/rate-limit.ts`)
  //    `@upstash/ratelimit` sliding-window limiters. Middleware excludes `/api/auth/*`
  //    from edge rate-limit rules so auth requests are never double-counted.
  rateLimit: authRateLimit,

  emailAndPassword: {
    enabled: true,
    minPasswordLength: 8,
    maxPasswordLength: 128,
    // #673 — a credential signup must prove email ownership before it can hold
    // a session. Without this an attacker can pre-register a victim's address; a
    // later OAuth login (see accountLinking below) would then auto-link the
    // real user into the attacker-seeded account (pre-hijacking).
    // OAuth/SSO are unaffected — the IdP already asserts a verified email.
    requireEmailVerification: true,
    password: {
      hash: (password) => bcrypt.hash(password, 12),
      verify: async ({ password, hash }) => {
        return bcrypt.compare(password, hash);
      },
    },
    sendResetPassword: async ({ user, token }) => {
      // A new operator's first "reset" is their invitation: the account was
      // created with a random password (lib/auth/operators.ts), so the email
      // says "set your password" until they have enrolled 2FA.
      const { role, twoFactorEnabled } = user as {
        role?: string | null;
        twoFactorEnabled?: boolean | null;
      };
      await sendPasswordResetEmail({
        email: user.email,
        name: user.name || "User",
        token,
        userId: user.id,
        invite: isOperatorRole(role) && twoFactorEnabled !== true,
      });
    },
    resetPasswordTokenExpiresIn: 1800, // 30 minutes
    // A reset ends EVERY session, a thief's included. The resetting browser
    // holds no session, so nothing needs preserving. (changePassword keeps
    // the current session via `revokeOtherSessions: true` instead.)
    revokeSessionsOnPasswordReset: true,
  },

  emailVerification: {
    // Send the link on signup. An unverified sign-in attempt is still rejected
    // (EMAIL_NOT_VERIFIED); the signin UI offers an explicit resend that lands
    // on /auth/verify-email — sendOnSignIn is left off so we don't also fire a
    // second link whose callbackURL would be "/".
    sendOnSignUp: true,
    // After clicking the link, drop the user straight into an authenticated
    // session so they land on the callbackURL (our verify-email page) — no
    // second login.
    autoSignInAfterVerification: true,
    expiresIn: 60 * 60, // 1 hour
    sendVerificationEmail: async ({ user, url }) => {
      await sendVerificationEmail({
        email: user.email,
        name: user.name || "User",
        verificationUrl: url,
        userId: user.id,
      });
    },
  },

  // Reset and verification tokens are stored as SHA-256, so a leaked
  // verifications table yields no usable links.
  verification: { storeIdentifier: "hashed" },

  socialProviders: {
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID ?? "",
      clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
    },
    github: {
      clientId: process.env.GITHUB_CLIENT_ID ?? "",
      clientSecret: process.env.GITHUB_CLIENT_SECRET ?? "",
    },
  },

  account: {
    accountLinking: {
      enabled: true,
      // No trustedProviders on purpose. A trusted provider links into an
      // existing account on its email claim alone, so a provider that lets
      // users set an unverified email could take over any account. Without
      // it, BetterAuth only auto-links when the provider asserts
      // email_verified AND the local user's email is verified
      // (requireLocalEmailVerified, default true).
    },
    // #1861 S1 / #1529 — Account.accessToken/refreshToken are encrypted with
    // the Better Auth secret; nothing in the app reads them directly. Legacy
    // plaintext rows keep reading via Better Auth's own fallback
    // (node_modules/better-auth/dist/oauth2/utils.mjs isLikelyEncrypted) and
    // vanish at the pre-MVP reset.
    encryptOAuthTokens: true,
    // #1876 §3 — Explicitly enable OAuth token rotation on every re-sign-in
    // (BetterAuth's default, stated here so an upstream default change cannot
    // silently disable it). Ensures accessToken/refreshToken/idToken and
    // accessTokenExpiresAt are refreshed and re-encrypted under
    // `encryptOAuthTokens: true` whenever a user signs in via Google/GitHub.
    updateAccountOnSignIn: true,
  },

  // Previously unset, so every cookie and IP attribute was BetterAuth's
  // implicit default. Each key below is now stated so it is reviewable and a
  // default change upstream cannot move it silently.
  advanced: {
    // Netlify serves over https, so this is already what BetterAuth derives —
    // but "already correct by coincidence" is not the same as asserted, and the
    // session cookie carries the whole session. Stated, not relied upon.
    useSecureCookies: true,
    // `__Secure-` is the default prefix with useSecureCookies on. Stated
    // because `lib/auth-session-lookup.ts` hardcodes both names when it has to
    // clear a stale cookie, and a prefix change would silently desync the two.
    cookiePrefix: "better-auth",
    defaultCookieAttributes: {
      // `lax` still sends the cookie on a top-level GET navigation, which is
      // what the OAuth and SSO callbacks are. `strict` would drop the session
      // on every one of them.
      sameSite: "lax",
      httpOnly: true,
    },
    ipAddress: {
      // The rate-limit key and the session's recorded IP. Most-trusted
      // first: `x-nf-client-connection-ip` is set by Netlify and cannot be
      // forged by a client. The fallbacks only matter off Netlify, and
      // BetterAuth ignores a multi-hop `x-forwarded-for` (no trustedProxies),
      // so a client cannot pick its own key by prepending addresses.
      ipAddressHeaders: [
        "x-nf-client-connection-ip",
        "x-vercel-forwarded-for",
        "x-forwarded-for",
      ],
      // Key IPv6 on the /64. One host usually owns a whole /64, so per-address
      // keys would let it rotate through 2^64 buckets.
      ipv6Subnet: 64,
    },
  },

  session: {
    expiresIn: 30 * 24 * 60 * 60, // 30 days
    updateAge: 24 * 60 * 60, // 24 hours
    // Off: every session read hits the database, so a revoke, ban or role
    // change applies on the very next request instead of up to 5 minutes
    // later. customSession already queries Prisma on every read, so the
    // cache saved one indexed lookup. Re-enabling it brings back the stale
    // window that getCachedSession() and the eslint freshness rule guard.
    cookieCache: { enabled: false },
  },

  user: {
    additionalFields: {
      role: {
        type: "string",
        required: false,
        defaultValue: "CONSULTEE",
        input: false,
      },
      onboardingCompleted: {
        type: "boolean",
        required: false,
        defaultValue: false,
        input: false,
      },
      phone: {
        type: "string",
        required: false,
      },
      timezone: {
        type: "string",
        required: false,
      },
      address: {
        type: "string",
        required: false,
      },
      consultantProfileId: {
        type: "string",
        required: false,
        input: false,
      },
      consulteeProfileId: {
        type: "string",
        required: false,
        input: false,
      },
      staffProfileId: {
        type: "string",
        required: false,
        input: false,
      },
      adminProfileId: {
        type: "string",
        required: false,
        input: false,
      },
      orgWorkspaceProfileId: {
        type: "string",
        required: false,
        input: false,
      },
    },
  },

  databaseHooks: {
    user: {
      create: {
        // Checked here as well as in account.create.before: the adapter runs
        // without transactions, so a refusal at the account step would leave
        // the user row (and its welcome email) behind, squatting the address.
        before: async (user, ctx) => {
          if (ctx?.path?.startsWith("/sso/")) {
            await assertSsoEmailOnDomain(ctx.params?.providerId, user.email);
          }
          // requireEmailVerification covers email/password only. A social
          // provider that reports the address unverified (GitHub can) must
          // not mint a session that claims it.
          if (
            ctx?.path?.startsWith("/callback/") &&
            user.emailVerified !== true
          ) {
            throw new APIError("FORBIDDEN", {
              message: "Verify this email address with the provider first.",
              code: "EMAIL_NOT_VERIFIED",
            });
          }
        },
        after: async (user, ctx) => {
          try {
            // NOTE: ConsulteeProfile used to be auto-created here for every
            // signup. It is now lazy — created on the first consumer action
            // (booking, trial, invite-accept as LEARNER, onboarding when
            // role=CONSULTEE) via `ensureConsulteeProfile` in
            // lib/profiles/ensure-consultee-profile.ts. This prevents
            // org-operators (UserRole.ORG_WORKSPACE) and consultants from
            // carrying a dangling consumer profile they never use.

            // Upserts, not creates (#1697 item 4): a re-run of this hook
            // (an SSO auto-provision retry, a replayed signup) used to die
            // on the userId unique and skip every step below it.
            await prisma.cookiePreference.upsert({
              where: { userId: user.id },
              create: { userId: user.id },
              update: {},
            });
            await prisma.notificationPreference.upsert({
              where: { userId: user.id },
              create: { userId: user.id },
              update: {},
            });

            // DPDP Act 2023: stamp a ConsentArtifact for the essential
            // purposes covered by the signup action (account creation
            // requires data processing for service delivery + video/chat
            // handoff to Stream.io). MARKETING_COMMS / ANALYTICS consent
            // is not stamped here — those require an explicit checkbox
            // on the signup form (P1 follow-up; see #701). When a user
            // hits the in-app withdrawal flow (/api/.../consent), this
            // artifact is superseded and `checkConsent` fails closed.
            //
            // #1846 — an account created by an SSO sign-in (JIT) was not
            // made by the person on a signup form, so nothing is stamped
            // for them here. Their first sign-in into the org shows the
            // consent step (JoinConsentGate), and accepting an invitation
            // shows it inline (#1854); both write these same rows.
            //
            // An operator account created by an admin (lib/auth/operators.ts,
            // through `auth.api.createUser`) is not that person's signup
            // either; they give consent themselves on first sign-in.
            const ssoProvisioned = ctx?.path?.startsWith("/sso/") ?? false;
            const operatorCreated = ctx?.path === "/admin/create-user";
            try {
              const drafts =
                ssoProvisioned || operatorCreated
                  ? []
                  : buildSignupConsentArtifacts(user.id);
              for (const draft of drafts) {
                await prisma.consentArtifact.create({ data: draft });
              }
            } catch (consentError) {
              // Fail open on consent stamping — the user-create hook
              // shouldn't sink a signup over an audit-trail glitch.
              //
              // There is NO backfill job. An earlier version of this comment
              // claimed a "/consent backfill cron (#701)" would re-create the
              // rows; that cron was never built, so the comment promised a
              // recovery path that did not exist and this failure was
              // permanently unrecoverable for the user.
              //
              // The real recovery path, and it is deliberate: `ConsentSection`
              // renders every purpose with a "Give consent" button, and the
              // gates are fail-closed, so a user with no artifact is denied at
              // checkout and at video/chat until they grant it themselves.
              // That is a degraded experience, not a compliance hole — the
              // alternative (failing the signup) would trade a recoverable
              // missing row for a lost account.
              //
              // If you want genuine backfill, it has to be built and
              // documented. Do not restore a reference to it until it exists.
              console.error(
                "[AUTH_HOOK] DPDP consent stamp error:",
                consentError,
              );
              Sentry.captureException(
                consentError instanceof Error
                  ? consentError
                  : new Error(String(consentError)),
                { tags: { subsystem: "auth" }, level: "warning" },
              );
            }

            // #1298 — awaited: an un-awaited send is dropped when the instance
            // freezes after the response (same class as #1616). Operators get
            // the setup email instead of the consumer welcome.
            try {
              if (!operatorCreated) {
                await sendWelcomeEmail({
                  email: user.email,
                  name: user.name || "User",
                  userId: user.id,
                });
              }
            } catch (err) {
              console.error("[AUTH_HOOK] Welcome email error:", err);
              Sentry.captureException(
                err instanceof Error ? err : new Error(String(err)),
                { tags: { subsystem: "auth" }, level: "warning" },
              );
            }

            // Sync Novu subscriber (fire and forget with error logging).
            // routingMode is the operator default; workspace owners who later
            // pick EMAIL_ONLY/BELL_ONLY re-sync via the workspace settings
            // PATCH + the subscriber hook.
            const nameParts = (user.name || "User").split(" ");
            syncSubscriber({
              userId: user.id,
              email: user.email,
              firstName: nameParts[0],
              lastName: nameParts.slice(1).join(" ") || undefined,
              routingMode: "BELL_AND_EMAIL",
            }).catch((err) => {
              console.error("[AUTH_HOOK] Novu subscriber sync error:", err);
              Sentry.captureException(
                err instanceof Error ? err : new Error(String(err)),
                { tags: { subsystem: "auth" }, level: "warning" },
              );
            });
          } catch (error) {
            console.error("[AUTH_HOOK] user.create.after error:", error);
            Sentry.captureException(
              error instanceof Error ? error : new Error(String(error)),
              { tags: { subsystem: "auth" } },
            );
          }
        },
      },
      update: {
        // Enrolment ends every session; the plugin then mints the enrolling
        // device's new one.
        after: async (user, ctx) => {
          if (isTwoFactorEnrolment(user, ctx?.path)) {
            await revokeAllUserSessions(prisma, user.id);
          }
        },
      },
    },
    // Server-side SSO veto (issue #673). Runs on every session creation path
    // — credential signin, OAuth signin, SSO signin, signup — just before the
    // cookie is issued, making this THE enforcement gate: a direct POST to
    // `/api/auth/sign-in/email` that bypasses our signin UI is rejected here
    // at the source rather than flagged reactively.
    //
    // For an enforced email domain only the org's own SSO callback may mint
    // the session. The hook fails open when the enforcing org has no
    // staff-approved `ssoProvider` rows — see `lib/sso/enforce-session.ts`.
    //
    // The same hook keeps operators on password + TOTP: the twoFactor plugin
    // never challenges a social or SSO callback, so those are refused here
    // for STAFF/ADMIN (lib/auth/operator-session-policy.ts). It also caps an
    // operator session at 12 hours; `update.before` holds that on refresh.
    session: {
      create: {
        before: async (session, ctx) => {
          const user = await prisma.user.findUnique({
            where: { id: session.userId },
            select: { email: true, role: true },
          });

          if (refusesOperatorSession(user?.role, ctx?.path)) {
            throw new APIError("FORBIDDEN", {
              message:
                "Staff accounts sign in with email, password and an authenticator code.",
              code: "STAFF_PASSWORD_SIGN_IN_ONLY",
            });
          }

          const decision = await shouldRejectSession({
            email: user?.email ?? null,
            path: ctx?.path,
            providerId: ctx?.params?.providerId,
            lookupEnforcedOrg: (domain) => lookupEnforcedOrg(prisma, domain),
          });

          if (decision.reject) {
            throw new APIError("FORBIDDEN", {
              message:
                "This email domain requires SSO sign-in through your organization's provider. Password and Google sign-in are off for it.",
              code: "SSO_REQUIRED",
            });
          }

          if (isOperatorRole(user?.role)) {
            return {
              data: {
                expiresAt: capOperatorExpiry(
                  session.createdAt ?? new Date(),
                  session.expiresAt,
                ),
              },
            };
          }
        },
      },
      update: {
        // Only get-session's sliding refresh writes `expiresAt`, and it has
        // just loaded this session and its user into `ctx.context.session`,
        // so the clamp needs no query. For an operator the refresh therefore
        // runs on every read (12h is always within the 30d-minus-1d window);
        // the write is one row by token, and operators are few.
        before: async (data, ctx) => {
          const current = ctx?.context.session;
          if (!data.expiresAt || !current) return;
          if (!isOperatorRole((current.user as { role?: string }).role)) return;
          return {
            data: {
              expiresAt: capOperatorExpiry(
                new Date(current.session.createdAt),
                new Date(data.expiresAt),
              ),
            },
          };
        },
      },
    },
    account: {
      create: {
        before: async (account) => {
          if (account.providerId === "credential") return;
          const user = await prisma.user.findUnique({
            where: { id: account.userId },
            select: { role: true, email: true },
          });
          if (refusesOperatorAccount(user?.role, account.providerId)) {
            throw new APIError("FORBIDDEN", {
              message:
                "Staff accounts sign in with email, password and an authenticator code.",
              code: "STAFF_PASSWORD_SIGN_IN_ONLY",
            });
          }
          if (isSsoProviderId(account.providerId)) {
            await assertSsoEmailOnDomain(account.providerId, user?.email);
          }
        },
        after: async (account) => {
          // Send account-linked email for non-credential providers
          if (account.providerId !== "credential") {
            try {
              const user = await prisma.user.findUnique({
                where: { id: account.userId },
                select: { email: true, name: true },
              });
              if (user?.email) {
                // #1298 — awaited: an un-awaited send is dropped when the
                // instance freezes after the response (same class as #1616).
                try {
                  await sendAccountLinkedEmail({
                    email: user.email,
                    name: user.name || "User",
                    provider: account.providerId,
                    userId: account.userId,
                  });
                } catch (err) {
                  console.error("[AUTH_HOOK] Account linked email error:", err);
                  Sentry.captureException(
                    err instanceof Error ? err : new Error(String(err)),
                    { tags: { subsystem: "auth" }, level: "warning" },
                  );
                }
              }
            } catch (error) {
              console.error("[AUTH_HOOK] account.create.after error:", error);
              Sentry.captureException(
                error instanceof Error ? error : new Error(String(error)),
                { tags: { subsystem: "auth" } },
              );
            }
          }
        },
      },
    },
  },

  plugins: [
    // Rejects breached passwords on sign-up, reset and change.
    breachedPasswordCheck,

    // Two-factor: TOTP (authenticator app) + single-use backup codes, used by
    // operators only. Mandatory for STAFF/ADMIN: `session.create.before`
    // limits them to credential + TOTP sessions, the API/page guards in
    // lib/auth-helpers.ts and lib/auth-guard.ts confine an unenrolled
    // operator to /auth/two-factor/setup, and lib/auth-server.ts's
    // getSession() reads their session as signed out everywhere else.
    //
    // `allowPasswordless` stays off, so enrolling needs the account password.
    // Every operator account is created with a credential account, so nobody
    // is stranded by it.
    twoFactor({
      issuer: "Familiarise",
      // The pending-2FA cookie is the window in which a correct password has
      // been given but the second factor has not. 10 minutes is the plugin
      // default and is right: long enough to fetch an authenticator, short
      // enough that a shoulder-surfed six-digit code is not worth waiting for.
      twoFactorCookieMaxAge: 600,
      backupCodeOptions: {
        amount: 10,
        length: 10,
        storeBackupCodes: "encrypted",
      },
    }),

    // Moderation (#693, starts #725 Tier-1): provides User.banned/banReason/
    // banExpires, blocks sign-in for banned users, and auto-unbans at sign-in
    // once banExpires passes (lazy suspension expiry — no cron). Ban writes
    // happen directly via Prisma in lib/moderation, not auth.api.banUser.
    // defaultRole must be a valid UserRole enum value — the plugin's
    // user.create.before hook otherwise writes "user" and breaks signup.
    admin({
      defaultRole: "CONSULTEE",
      adminRoles: ["ADMIN", "STAFF"],
      // adminRoles must map to keys in `roles` or the plugin throws at
      // module load. STAFF = moderator: a subset of full admin capability.
      roles: { ADMIN: adminAc, STAFF: staffAc, user: userAc },
      bannedUserMessage:
        "Your account has been suspended. If you believe this is a mistake, please contact support.",
    }),

    // Enterprise: SSO plugin (OIDC). Per-org providers are linked via
    // `SsoProvider.organizationId`; options and the JIT membership hook live
    // in lib/sso/plugin-options.ts.
    sso(ssoPluginOptions),

    customSession(async ({ user: baseUser, session }) => {
      // Cast to include additionalFields (available at runtime via BetterAuth,
      // but not reflected in the customSession callback's parameter type)
      const user = baseUser as typeof baseUser & {
        role?: string | null;
        onboardingCompleted?: boolean | null;
        phone?: string | null;
        address?: string | null;
        timezone?: string | null;
        consultantProfileId?: string | null;
        consulteeProfileId?: string | null;
        staffProfileId?: string | null;
        adminProfileId?: string | null;
        orgWorkspaceProfileId?: string | null;
        twoFactorEnabled?: boolean | null;
        banned?: boolean | null;
        banExpires?: Date | null;
      };

      // #693 defense-in-depth: sessions are deleted at ban time and sign-in
      // is plugin-gated, but a session minted in the race window must still
      // resolve as banned. `user` is the row BetterAuth just read (the cookie
      // cache is off), so it is current.
      const effectivelyBanned =
        user.banned === true &&
        (!user.banExpires || new Date(user.banExpires) > new Date());

      // Load active org memberships so OrgSwitcher + checkout can render
      // without an extra roundtrip.
      const memberships = await prisma.membership.findMany({
        where: { status: "ACTIVE", userId: user.id },
        select: {
          role: true,
          organizationId: true,
          departmentLabel: true,
          organization: {
            select: {
              id: true,
              name: true,
              slug: true,
              brandingProfile: { select: { logo: true } },
              status: true,
              canSponsor: true,
              canHost: true,
              billingAccount: {
                select: {
                  id: true,
                  fundingSource: true,
                  walletBalance: true,
                },
              },
            },
          },
        },
      });

      // Shape returned on every session. The session is hot — every
      // authenticated request reads it — so we keep the payload flat
      // and small, and resolve labels at render time via
      // lib/labels/org-labels.ts instead of precomputing them here.
      // Legacy fields (kind / billingMode / creditBalance /
      // organizationProfileId / contractEndDate) were removed in
      // Checkpoint 8; the dashboard now consumes the capability
      // booleans + fundingSource directly.
      const organizationMemberships = memberships
        .filter((m) => m.organization.status === "ACTIVE")
        .map((m) => ({
          organizationId: m.organization.id,
          organizationName: m.organization.name,
          organizationSlug: m.organization.slug,
          organizationLogo: m.organization.brandingProfile?.logo ?? null,
          role: m.role,
          departmentLabel: m.departmentLabel,
          canSponsor: m.organization.canSponsor,
          canHost: m.organization.canHost,
          fundingSource: m.organization.billingAccount?.fundingSource ?? null,
          walletBalance: m.organization.billingAccount?.walletBalance ?? null,
        }));

      // SSO enforcement: the primary gate lives in
      // `databaseHooks.session.create.before` (above) — every session-creation
      // path (credential, OAuth, SSO, signup) is vetoed there when the user's
      // email domain is under an enforced org and the session did not come
      // through that org's SSO callback (issue #673).
      //
      // A read-time recheck that flagged bypassed sessions via
      // `ssoEnforcementFailed` used to live here. It was removed: no layout,
      // guard, or component ever consumed the flag (docs claimed layouts
      // redirect on it — none did), so it cost two DB round-trips
      // (lookupEnforcedOrg + account probe) on EVERY session resolution —
      // the hottest read in the app — for a value nobody read. Re-introduce
      // enforcement-at-read-time only with an actual consumer; see the SSO
      // enforcement lifecycle issue for the full plan.

      return {
        user: {
          ...user,
          sentryUserId: isSentryIdentityEnabled()
            ? resolveSentryUserId(user.id)
            : undefined,
          role: user.role ?? "CONSULTEE",
          onboardingCompleted: user.onboardingCompleted ?? false,
          phone: user.phone ?? undefined,
          address: user.address ?? undefined,
          timezone: user.timezone ?? undefined,
          consultantProfileId: user.consultantProfileId ?? undefined,
          consulteeProfileId: user.consulteeProfileId ?? undefined,
          staffProfileId: user.staffProfileId ?? undefined,
          adminProfileId: user.adminProfileId ?? undefined,
          orgWorkspaceProfileId: user.orgWorkspaceProfileId ?? undefined,
          banned: effectivelyBanned,
          // Read by the operator 2FA gates (lib/auth-helpers.ts,
          // lib/auth-guard.ts). Fresh per request: the cookie cache is off,
          // so `user` is the row BetterAuth just read.
          twoFactorEnabled: user.twoFactorEnabled === true,
          organizationMemberships,
        },
        // The token is the cookie's value — a bearer credential. The
        // browser already holds it (httpOnly); it never needs it in JSON.
        session: sessionWithoutToken(session),
      };
    }),
    nextCookies(), // Must be last
  ],
});

function sessionWithoutToken<T extends { token: string }>(
  session: T,
): Omit<T, "token"> {
  const { token: _token, ...rest } = session;
  return rest;
}

export type Session = typeof auth.$Infer.Session;
