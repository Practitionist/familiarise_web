import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { nextCookies } from "better-auth/next-js";
import { admin, customSession, emailOTP, twoFactor } from "better-auth/plugins";
import { adminAc, userAc, defaultAc } from "better-auth/plugins/admin/access";
import { sso } from "@better-auth/sso";
import { passkey } from "@better-auth/passkey";
import bcrypt from "bcrypt";
import prisma from "@/lib/prisma";
import { scheduleAfter } from "@/lib/api/after-safe";
import { sendPasswordResetEmail } from "@/lib/email";
import { assertSsoSessionAllowed } from "@/lib/sso/enforce-session";
import { ssoPluginOptions } from "@/lib/sso/plugin-options";
import {
  assertSsoAccountLink,
  assertSsoEmailOnDomain,
  isSsoProviderId,
} from "@/lib/sso/account-domain";
import {
  VERIFICATION_CODE_TTL_SECONDS,
  accountLifecycle,
  notifyAccountLinked,
  notifyExistingAccountSignUp,
  onPasswordReset,
  provisionNewUser,
  sendVerificationCode,
  userFlags,
  welcomeVerifiedUser,
} from "@/lib/auth/account-lifecycle";
import { reportAuthLogToSentry } from "@/lib/auth/auth-logger";
import { corePolicy } from "@/lib/auth/core-policy";
import {
  isOperatorRole,
  refusesOperatorAccount,
  refusesOperatorSession,
} from "@/lib/auth/operator-session-policy";
import {
  authenticationStart,
  cappedSessionFields,
  refreshSessionLifetime,
  sessionMaxAgeMs,
} from "@/lib/auth/session-lifetime";
import { supersededSessionRevocation } from "@/lib/auth/supersede-session";
import { breachedPasswordCheck } from "@/lib/auth/password-policy";
import {
  PASSWORD_MAX_BYTES,
  PASSWORD_MIN_LENGTH,
} from "@/lib/auth/password-rules";
import { authRateLimit } from "@/lib/auth/rate-limit";
import { stripSessionToken } from "@/lib/auth/strip-session-token";
import { notifySecurityEvents } from "@/lib/auth/security-event-hook";
import {
  revokeAllUserSessions,
  revokeSessionById,
} from "@/lib/auth/session-revoke";
import { socialProviderConfig } from "@/lib/auth/social-providers";
import {
  assertOperatorMayEnableTwoFactor,
  assertTwoFactorRequestPolicy,
  generateBackupCodes,
  isTwoFactorEnrolment,
} from "@/lib/auth/two-factor-policy";
import { assertSensitiveAuthAction } from "@/lib/auth/step-up";
import {
  assertOperatorMayRegisterPasskey,
  operatorPasskeyOptions,
} from "@/lib/auth/passkey-policy";
import { sendSecurityEventEmail } from "@/lib/auth/security-email";
import {
  isSentryIdentityEnabled,
  resolveSentryUserId,
} from "@/lib/observability/identity";

// STAFF = moderator: read users only. No `session:*` (those endpoints return
// raw tokens) and no `set-role`/`ban`: /admin/set-role never compares ranks.
const staffAc = defaultAc.newRole({
  user: ["list", "get"],
});

export const auth = betterAuth({
  secret: process.env.BETTER_AUTH_SECRET,
  baseURL: process.env.BETTER_AUTH_URL,
  trustedOrigins: (process.env.BETTER_AUTH_TRUSTED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),

  // BetterAuth swallows endpoint exceptions into 500s; this forwards its
  // `error` logs to Sentry (lib/auth/auth-logger.ts).
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
    // Verification is a 6-digit code (emailOTP below). The link endpoints and
    // the plugin's OTP sign-in, reset and email-change flows stay unmounted.
    "/verify-email",
    "/send-verification-email",
    "/sign-in/email-otp",
    "/email-otp/check-verification-otp",
    "/email-otp/request-password-reset",
    "/forget-password/email-otp",
    "/email-otp/reset-password",
    "/email-otp/request-email-change",
    "/email-otp/change-email",
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

  // SSO is OIDC-only, but @better-auth/sso 1.7.7 has no switch to leave the
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
      await assertTwoFactorRequestPolicy(ctx);
      await assertOperatorMayEnableTwoFactor(ctx);
      await assertSensitiveAuthAction(ctx);
      await assertOperatorMayRegisterPasskey(ctx);
    }),
    after: createAuthMiddleware(async (ctx) => {
      await notifySecurityEvents(ctx);
      return stripSessionToken(ctx);
    }),
  },

  database: prismaAdapter(prisma, {
    provider: "postgresql",
  }),

  // Per-IP budgets in Upstash (lib/auth/rate-limit.ts); middleware.ts skips
  // /api/auth/* so nothing is counted twice.
  rateLimit: authRateLimit,

  emailAndPassword: {
    enabled: true,
    minPasswordLength: PASSWORD_MIN_LENGTH,
    // bcrypt reads 72 bytes; password-policy.ts also caps the UTF-8 byte length.
    maxPasswordLength: PASSWORD_MAX_BYTES,
    // No session until the address is proven, so a pre-registered victim
    // address cannot be auto-linked into on a later OAuth sign-in. This also
    // makes a duplicate sign-up answer exactly like a new one.
    requireEmailVerification: true,
    onExistingUserSignUp: async ({ user }) => {
      await notifyExistingAccountSignUp(user);
    },
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
    onPasswordReset: async ({ user }) => {
      await onPasswordReset(user);
    },
  },

  // The sender is emailOTP's (overrideDefaultEmailVerification): the code is
  // typed into the tab that chose the password, so whoever verifies holds both.
  emailVerification: {
    sendOnSignUp: true,
    // Only reached after the password matched, so it proves the password too.
    sendOnSignIn: true,
    autoSignInAfterVerification: true,
    // Credential sign-ups get consent and the welcome mail only now.
    afterEmailVerification: async (user) => {
      if (isOperatorRole(userFlags(user).role)) return;
      await welcomeVerifiedUser(user, { stampConsent: true });
    },
  },

  // Reset tokens and OTP identifiers are stored as SHA-256, so a leaked
  // verifications table yields no usable links or codes.
  verification: { storeIdentifier: "hashed" },

  // Only providers whose client id and secret are configured.
  socialProviders: socialProviderConfig(),

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
    // OAuth tokens are encrypted with the Better Auth secret; nothing in the
    // app reads them directly.
    encryptOAuthTokens: true,
    // Stated so an upstream default change cannot stop token rotation.
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
    // Auth mail is sent after the response (Netlify waitUntil), so response
    // time no longer reveals whether an address has an account.
    backgroundTasks: {
      handler: (promise) => scheduleAfter(() => promise, "auth:background"),
    },
  },

  session: {
    expiresIn: 30 * 24 * 60 * 60, // 30 days
    updateAge: 24 * 60 * 60, // 24 hours
    // Off: every session read hits the database, so a revoke, ban or role
    // change applies on the very next request. Lifetime caps for operators
    // and SSO sessions live in lib/auth/session-lifetime.ts.
    cookieCache: { enabled: false },
    // Stamped by app/api/user/reauthenticate; read by lib/auth/step-up.ts.
    additionalFields: {
      reauthenticatedAt: { type: "date", required: false, input: false },
    },
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
      // Written server-side by onboarding and profile routes, never through
      // /sign-up/email or /update-user.
      phone: {
        type: "string",
        required: false,
        input: false,
      },
      timezone: {
        type: "string",
        required: false,
        input: false,
      },
      address: {
        type: "string",
        required: false,
        input: false,
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
            return { data: { emailVerified: true } };
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
          await provisionNewUser(user, ctx?.path);
        },
      },
      update: {
        // Enrolment ends every session; the plugin then mints the enrolling
        // device's new one.
        after: async (user, ctx) => {
          if (isTwoFactorEnrolment(user, ctx?.path)) {
            await revokeAllUserSessions(prisma, user.id);
            await sendSecurityEventEmail(user, { kind: "authenticator-added" });
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
    // For an enforced email domain only an approved provider covering that
    // domain may mint the session, through its SSO callback. Domains no
    // approved provider covers fail open — see `lib/sso/enforce-session.ts`.
    //
    // The same hook keeps operators on password + TOTP: the twoFactor plugin
    // never challenges a social or SSO callback, so those are refused here
    // for STAFF/ADMIN (lib/auth/operator-session-policy.ts). It also applies
    // the lifetime caps (lib/auth/session-lifetime.ts); `update.before` holds
    // them on refresh.
    session: {
      create: {
        before: async (session, ctx) => {
          const user = await prisma.user.findUnique({
            where: { id: session.userId },
            select: { email: true, role: true, twoFactorEnabled: true },
          });

          if (refusesOperatorSession(user?.role, ctx?.path)) {
            throw new APIError("FORBIDDEN", {
              message:
                "Staff accounts sign in with email, password and an authenticator code.",
              code: "STAFF_PASSWORD_SIGN_IN_ONLY",
            });
          }

          const enforcedOrg = await assertSsoSessionAllowed(prisma, {
            email: user?.email,
            path: ctx?.path,
            providerId: ctx?.params?.providerId,
          });

          const ssoEnforced =
            ctx?.path === "/sso/callback/:providerId" &&
            (enforcedOrg?.registeredProviderIds.length ?? 0) > 0;
          const maxAgeMs = sessionMaxAgeMs(user, { ssoEnforced });
          if (maxAgeMs === null) return;
          const authStart = authenticationStart(
            ctx?.path,
            session.userId,
            ctx?.context.session?.session,
            new Date(),
          );
          return {
            data: cappedSessionFields(session.expiresAt, authStart, maxAgeMs),
          };
        },
      },
      update: {
        // Only get-session's sliding refresh writes `expiresAt`, and it has
        // just loaded this session and its user into `ctx.context.session`,
        // so the policy needs no query. Returning false makes BetterAuth drop
        // the cookie and answer no session; the row is revoked first.
        before: async (data, ctx) => {
          const current = ctx?.context.session;
          if (!data.expiresAt || !current) return;
          const decision = refreshSessionLifetime(
            current.user as { role?: string; twoFactorEnabled?: boolean },
            current.session,
            new Date(data.expiresAt),
            new Date(),
          );
          if (decision.kind === "end") {
            await revokeSessionById(
              prisma,
              current.session.userId,
              current.session.id,
            );
            return false;
          }
          if (decision.expiresAt) {
            return { data: { expiresAt: decision.expiresAt } };
          }
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
            await assertSsoAccountLink(account, user?.email);
          }
        },
        after: async (account) => {
          await notifyAccountLinked(account);
        },
      },
    },
  },

  plugins: [
    // Rejects breached and over-72-byte passwords on sign-up, reset and change.
    breachedPasswordCheck,

    // Display-name rules, OTP type restriction, sign-up race answer.
    corePolicy,

    // Password-changed notice and token cleanup after /change-password.
    accountLifecycle,

    // Email verification only: the sign-in, reset and email-change flows the
    // plugin also mounts are listed in `disabledPaths`.
    emailOTP({
      overrideDefaultEmailVerification: true,
      sendVerificationOnSignUp: true,
      otpLength: 6,
      expiresIn: VERIFICATION_CODE_TTL_SECONDS,
      allowedAttempts: 5,
      storeOTP: "hashed",
      disableSignUp: true,
      sendVerificationOTP: async ({ email, otp, type }) => {
        if (type === "email-verification") {
          await sendVerificationCode(email, otp);
        }
      },
    }),

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
        customBackupCodesGenerate: generateBackupCodes,
      },
    }),

    // After twoFactor(), which clears `newSession` while a challenge is pending.
    supersededSessionRevocation,
    // Operator passkeys: registration is limited to enrolled operators in
    // hooks.before, and TOTP stays the recovery factor.
    passkey(operatorPasskeyOptions(process.env.BETTER_AUTH_URL)),

    // Moderation: provides User.banned/banReason/banExpires, blocks sign-in
    // for banned users and auto-unbans once banExpires passes. Ban writes go
    // through lib/moderation via Prisma, not auth.api.banUser.
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
        session: publicSession(session),
      };
    }),
    nextCookies(), // Must be last
  ],
});

/**
 * The token is the cookie's value, a bearer credential the browser already
 * holds. Impersonation is off, so its column never reaches the client either.
 */
function publicSession<T extends { token: string; impersonatedBy?: unknown }>(
  session: T,
): Omit<T, "token" | "impersonatedBy"> {
  const { token: _token, impersonatedBy: _impersonatedBy, ...rest } = session;
  return rest;
}

export type Session = typeof auth.$Infer.Session;
