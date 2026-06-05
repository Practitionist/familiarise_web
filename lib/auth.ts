import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { nextCookies } from "better-auth/next-js";
import { customSession, organization } from "better-auth/plugins";
import { sso } from "@better-auth/sso";
import bcrypt from "bcrypt";
import { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import {
  sendWelcomeEmail,
  sendAccountLinkedEmail,
  sendPasswordResetEmail,
} from "@/lib/email";
import { syncSubscriber } from "@/lib/novu/subscriber";
import { shouldRejectSession, lookupEnforcedOrg } from "@/lib/sso/enforce-session";
import { applyMembershipRoleEffects } from "@/lib/api/organizations/membership-transitions";
import { buildConsentArtifact } from "@/lib/compliance/dpdp";

export const auth = betterAuth({
  secret: process.env.BETTER_AUTH_SECRET,
  baseURL: process.env.BETTER_AUTH_URL,
  trustedOrigins: process.env.BETTER_AUTH_TRUSTED_ORIGINS
    ? process.env.BETTER_AUTH_TRUSTED_ORIGINS.split(",")
    : [],

  database: prismaAdapter(prisma, {
    provider: "postgresql",
  }),

  // BetterAuth's built-in rate limit is disabled here on purpose.
  //
  // Why: BetterAuth's limiter is in-memory per Node.js process. We
  // deploy to Netlify (serverless) where each cold-start lambda gets
  // its own counter, so an attacker who rotates through enough lambdas
  // can race past any per-process gate. A globally-coherent limit has
  // to live in shared state (Upstash Redis).
  //
  // Coverage is provided by the Upstash-backed `authLimiter` in
  // `middleware.ts:192-197` at 10 requests / 15min / IP across:
  //   - POST /api/auth/sign-up/email
  //   - POST /api/auth/sign-in/email
  //   - POST /api/auth/forget-password
  //   - POST /api/auth/reset-password
  //
  // The unauth `/api/auth/sso/domain-check` endpoint has its own
  // 60/hr/IP gate at `middleware.ts:240-246` (prevents domain
  // enumeration of registered orgs). Wallet top-ups have a per-org
  // limiter keyed on `org:${orgId}`.
  //
  // Localhost (`::1` / `127.0.0.1` / `unknown_ip`) bypasses these
  // limits via `isBypassableIp` so booking-algorithm-tests + agent
  // runs aren't slowed down; production traffic never bypasses.
  //
  // If you ever re-enable BetterAuth's rate limit, audit the overlap
  // against `authLimiter` to avoid double-counting and the surprises
  // that follow (two different 429 responses for the same flow).
  // See audit Phase B.8 + docs/enterprise/20-iam-and-security/04-rate-limiting.md.
  rateLimit: {
    enabled: false,
  },

  emailAndPassword: {
    enabled: true,
    minPasswordLength: 8,
    maxPasswordLength: 128,
    password: {
      hash: async (password) => {
        return bcrypt.hash(password, 12);
      },
      verify: async ({ password, hash }) => {
        return bcrypt.compare(password, hash);
      },
    },
    sendResetPassword: async ({ user, url }) => {
      // Extract token from URL for the email template
      const urlObj = new URL(url);
      const token = urlObj.searchParams.get("token") || "";
      await sendPasswordResetEmail({
        email: user.email,
        name: user.name || "User",
        token,
      });
    },
    resetPasswordTokenExpiresIn: 1800, // 30 minutes
  },

  socialProviders: {
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID ?? "",
      clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
    },
    github: {
      clientId: process.env.GITHUB_CLIENT_ID ?? "",
      clientSecret: process.env.GITHUB_CLIENT_SECRET ?? "",
    },
    facebook: {
      clientId: process.env.FACEBOOK_CLIENT_ID ?? "",
      clientSecret: process.env.FACEBOOK_CLIENT_SECRET ?? "",
    },
  },

  account: {
    accountLinking: {
      enabled: true,
      // "credential" is intentionally not listed. trustedProviders only applies
      // to OAuth providers during the implicit auto-link flow in BetterAuth's
      // callback handler. Credential accounts are created explicitly during
      // sign-up, not via OAuth auto-link.
      trustedProviders: ["google", "github", "facebook"],
    },
  },

  session: {
    expiresIn: 30 * 24 * 60 * 60, // 30 days
    updateAge: 24 * 60 * 60, // 24 hours
    cookieCache: {
      enabled: true,
      maxAge: 5 * 60, // 5 minutes
      strategy: "compact",
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
      // Session-generation marker carried in the session payload. The
      // customSession callback compares this to the current row value
      // on every session lookup; if they diverge, the cached
      // memberships array is stale and we refetch. See audit Phase B.5
      // and docs/enterprise/20-iam-and-security/02-jit-and-session-refresh.md.
      sessionGeneration: {
        type: "number",
        required: false,
        defaultValue: 0,
        input: false,
      },
    },
  },

  databaseHooks: {
    user: {
      create: {
        after: async (user) => {
          try {
            // NOTE: ConsulteeProfile used to be auto-created here for every
            // signup. It is now lazy — created on the first consumer action
            // (booking, trial, invite-accept as LEARNER, onboarding when
            // role=CONSULTEE) via `ensureConsulteeProfile` in
            // lib/profiles/ensure-consultee-profile.ts. This prevents
            // org-operators (UserRole.ORG_WORKSPACE) and consultants from
            // carrying a dangling consumer profile they never use.

            // Create CookiePreference
            await prisma.cookiePreference.create({
              data: { userId: user.id },
            });

            // Create NotificationPreference
            await prisma.notificationPreference.create({
              data: { userId: user.id },
            });

            // DPDP Act 2023: stamp a ConsentArtifact for the essential
            // purposes covered by the signup action (account creation
            // requires data processing for service delivery + video/chat
            // handoff to Stream.io). MARKETING_COMMS / analytics consent
            // is not stamped here — those require an explicit checkbox
            // on the signup form (P1 follow-up; see #701). When a user
            // hits the in-app withdrawal flow (/api/.../consent), this
            // artifact is superseded and `checkConsent` fails closed.
            try {
              for (const purposeCode of [
                "PRIMARY_PROCESSING",
                "STREAM_DATA_PROCESSING",
              ] as const) {
                const draft = buildConsentArtifact({
                  userId: user.id,
                  dataFiduciary: "Familiarise",
                  purposeCodes: [purposeCode],
                  language: "en-IN",
                  consentManager: null,
                  version: 1,
                });
                await prisma.consentArtifact.create({ data: draft });
              }
            } catch (consentError) {
              // Fail open on consent stamping — the user-create hook
              // shouldn't sink a signup over an audit-trail glitch. The
              // /consent backfill cron (#701) re-creates missing rows.
              console.error("[AUTH_HOOK] DPDP consent stamp error:", consentError);
            }

            // Send welcome email (fire and forget)
            sendWelcomeEmail({
              email: user.email,
              name: user.name || "User",
            }).catch((err) =>
              console.error("[AUTH_HOOK] Welcome email error:", err),
            );

            // Sync Novu subscriber (fire and forget with error logging)
            const nameParts = (user.name || "User").split(" ");
            syncSubscriber({
              userId: user.id,
              email: user.email,
              firstName: nameParts[0],
              lastName: nameParts.slice(1).join(" ") || undefined,
            }).catch((err) =>
              console.error("[AUTH_HOOK] Novu subscriber sync error:", err),
            );
          } catch (error) {
            console.error("[AUTH_HOOK] user.create.after error:", error);
          }
        },
      },
    },
    // Server-side SSO veto (issue #673). Runs on every session creation path
    // — credential signin, OAuth signin, SSO signin, signup — just before the
    // cookie is issued. Reading-time enforcement via `ssoEnforcementFailed`
    // in `customSession` below is kept for defense-in-depth but is not the
    // primary gate: a direct POST to `/api/auth/sign-in/email` that bypasses
    // our signin UI would previously create a valid session and only set the
    // flag reactively. This hook rejects such requests at the source.
    //
    // Legitimate first-time SSO users are allowed because the SSO plugin
    // creates the `account` row with `providerId = ssoProvider.providerId`
    // BEFORE the session is created; returning SSO users already have that
    // account. The hook fails open when the enforcing org has not yet
    // registered any `ssoProvider` rows — see `lib/sso/enforce-session.ts`.
    session: {
      create: {
        before: async (session) => {
          const user = await prisma.user.findUnique({
            where: { id: session.userId },
            select: { email: true },
          });

          const decision = await shouldRejectSession({
            email: user?.email ?? null,
            userId: session.userId,
            // Delegate to the shared `lookupEnforcedOrg` (audit B.6).
            // The previous inline implementation lived here AND at
            // `customSession` AND at `/api/auth/sso/domain-check`,
            // with subtle drift between them — see issue #673.
            lookupEnforcedOrg: (domain) => lookupEnforcedOrg(prisma, domain),
            hasAccountInProviders: async (userId, providerIds) => {
              const match = await prisma.account.findFirst({
                where: { userId, providerId: { in: providerIds } },
                select: { id: true },
              });
              return !!match;
            },
          });

          if (decision.reject) {
            throw new APIError("FORBIDDEN", {
              message:
                "This email domain requires SSO sign-in. Please use your organization's SSO provider at /auth/signin.",
              code: "SSO_REQUIRED",
            });
          }
        },
      },
    },
    account: {
      create: {
        after: async (account) => {
          // Send account-linked email for non-credential providers
          if (account.providerId !== "credential") {
            try {
              const user = await prisma.user.findUnique({
                where: { id: account.userId },
                select: { email: true, name: true },
              });
              if (user?.email) {
                sendAccountLinkedEmail({
                  email: user.email,
                  name: user.name || "User",
                  provider: account.providerId,
                }).catch((err) =>
                  console.error("[AUTH_HOOK] Account linked email error:", err),
                );
              }
            } catch (error) {
              console.error("[AUTH_HOOK] account.create.after error:", error);
            }
          }
        },
      },
    },
  },

  plugins: [
    // Enterprise: BetterAuth Organization plugin.
    // Arch 4-Modified: BetterAuth Member.role is a free-form string; the
    // source of truth is our Membership model (linked via
    // Membership.betterAuthMemberId). On creator-role assignment we pass the
    // new enum name "OWNER" which our auth-helpers normalize.
    organization({
      organizationLimit: 5,
      creatorRole: "OWNER",
    }),

    // Enterprise: SSO plugin (SAML / OIDC).
    // Auto-generates the `ssoProvider` table. Per-org providers are linked
    // via `organizationId` on the row. See lib/auth-helpers.ts and the
    // OrganizationSSOSettings model in prisma/schema.prisma for the policy
    // layer (allowedEmailDomains, enforceSSO).
    sso(),

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
        sessionGeneration?: number | null;
      };

      // Read the user's current session-generation marker + the
      // profile FKs we'll need below for any bareMembers JIT auto-join.
      //
      // The marker is carried in the session payload primarily for
      // observability + a future fast-path that can skip the membership
      // re-fetch when the marker hasn't moved (audit B.5).
      //
      // Pre-fetching the profile FKs lets us pass them into
      // `applyMembershipRoleEffects` via `preloadedProfiles` so each
      // bareMember in the loop below skips a redundant `findUnique`.
      // Audit Phase B.7 — for users in 10 SSO orgs this is the
      // difference between 10 extra `users.findUnique` round-trips on
      // every session lookup and zero.
      const currentUserRow = await prisma.user.findUnique({
        where: { id: user.id },
        select: {
          sessionGeneration: true,
          consulteeProfileId: true,
          consultantProfileId: true,
        },
      });
      const liveSessionGeneration =
        currentUserRow?.sessionGeneration ?? user.sessionGeneration ?? 0;
      const preloadedProfiles = currentUserRow
        ? {
            consulteeProfileId: currentUserRow.consulteeProfileId,
            consultantProfileId: currentUserRow.consultantProfileId,
          }
        : undefined;

      // SSO membership sync: BetterAuth auto-provisioning creates a BetterAuth
      // Member row; we need a typed Membership sibling. Auto-repair any
      // missing Membership rows so SSO-provisioned users get access on first
      // session load.
      const bareMembers = await prisma.member.findMany({
        where: { userId: user.id, membership: null },
        select: {
          id: true,
          organizationId: true,
          role: true,
          organization: {
            select: {
              id: true,
              ssoSettings: { select: { defaultRoleForAutoJoin: true } },
            },
          },
        },
      });
      for (const bm of bareMembers) {
        if (!bm.organization) continue;
        const defaultRole = bm.organization.ssoSettings?.defaultRoleForAutoJoin ?? "LEARNER";
        try {
          // Wrap the role-effect resolution + Membership create in a
          // transaction so the lazy-created profile (LEARNER →
          // ConsulteeProfile, EXPERT → ConsultantProfile) and the
          // Membership row commit atomically.
          await prisma.$transaction(async (tx) => {
            const roleEffects = await applyMembershipRoleEffects(tx, {
              userId: user.id,
              role: defaultRole,
              // Pre-fetched at the top of customSession to avoid an
              // N+1 across the bareMembers loop. Audit Phase B.7.
              preloadedProfiles,
            });
            await tx.membership.create({
              data: {
                userId: user.id,
                organizationId: bm.organizationId,
                role: defaultRole,
                status: "ACTIVE",
                consulteeProfileId: roleEffects.consulteeProfileId,
                consultantProfileId: roleEffects.consultantProfileId,
                payoutRecipient: roleEffects.payoutRecipient,
                betterAuthMemberId: bm.id,
              },
            });
          });
        } catch (err) {
          // Narrow to P2002 (unique-constraint violation) ONLY. The
          // prior bare `catch {}` swallowed every error during the JIT
          // auto-join transaction, including:
          //   - Transient DB connection drops (would leave the user
          //     with NO Membership row and a working session, landing
          //     them on a broken dashboard).
          //   - Permission errors from Supabase RLS (silent denial of
          //     service).
          //   - Domain-upsert races other than uniqueness (e.g. FK
          //     violations from a stale cache).
          // Re-throw everything else so it surfaces at the BetterAuth
          // boundary and the user sees an error toast instead of a
          // silent broken state. See audit Phase A.3.
          if (
            err instanceof Prisma.PrismaClientKnownRequestError &&
            err.code === "P2002"
          ) {
            // Concurrent session-create won the membership — safe to ignore.
            continue;
          }
          throw err;
        }
      }

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

      // SSO enforcement: mark sessions that bypassed SSO for enforced
      // domains. Read-time defense-in-depth; the primary gate is in
      // `databaseHooks.session.create.before` (above). Keeping a single
      // enforcement path via the shared `lookupEnforcedOrg` helper
      // means credential-signin and read-time reconciliation can't
      // disagree on who counts as "enforced" — historically this was
      // issue #673.
      //
      // An account satisfies enforcement only if `account.providerId`
      // matches one of the `ssoProvider.providerId` rows registered
      // for the enforcing org. Checking against `providerId != "credential"`
      // is NOT enough — that would treat a personal Google or GitHub
      // OAuth account as a valid SSO sign-in, bypassing the policy.
      let ssoEnforcementFailed = false;
      try {
        const email = user.email;
        const domain = email?.split("@")[1]?.toLowerCase();
        if (domain) {
          const enforced = await lookupEnforcedOrg(prisma, domain);
          // `lookupEnforcedOrg` returns null when enforcement doesn't
          // apply (unverified claim, inactive org, allowlist mismatch,
          // enforceSSO=false). It also returns an empty
          // `registeredProviderIds` array when the org has flipped
          // enforceSSO on but hasn't added a provider yet — fail-open
          // there, matching `shouldRejectSession`'s behaviour, so a
          // half-configured org doesn't flag every session as failed.
          if (enforced && enforced.registeredProviderIds.length > 0) {
            const linkedViaSSO = await prisma.account.findFirst({
              where: {
                userId: user.id,
                providerId: { in: enforced.registeredProviderIds },
              },
              select: { id: true },
            });
            if (!linkedViaSSO) ssoEnforcementFailed = true;
          }
        }
      } catch {
        // non-fatal — don't break session
      }

      return {
        user: {
          ...user,
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
          // Always emit the live value so client code can detect a
          // stale session by comparing this against its cached payload.
          sessionGeneration: liveSessionGeneration,
          organizationMemberships,
          ssoEnforcementFailed,
        },
        session,
      };
    }),
    nextCookies(), // Must be last
  ],
});

export type Session = typeof auth.$Infer.Session;
