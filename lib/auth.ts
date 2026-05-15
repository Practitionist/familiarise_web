import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { nextCookies } from "better-auth/next-js";
import { customSession, organization } from "better-auth/plugins";
import { sso } from "@better-auth/sso";
import bcrypt from "bcrypt";
import prisma from "@/lib/prisma";
import {
  sendWelcomeEmail,
  sendAccountLinkedEmail,
  sendPasswordResetEmail,
} from "@/lib/email";
import { syncSubscriber } from "@/lib/novu/subscriber";
import { shouldRejectSession } from "@/lib/sso/enforce-session";
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
            lookupEnforcedOrg: async (domain) => {
              // Use OrgDomainClaim as the authoritative "who owns this
              // email domain" record (matches /api/auth/sso/domain-check
              // exactly). `OrganizationSSOSettings.allowedEmailDomains`
              // is an additional curated allowlist, honoured *after* the
              // claim — a caught-in-transition domain owned by the org
              // but not currently in allowedEmailDomains should fall
              // through to credentials, not be force-rejected.
              const claim = await prisma.orgDomainClaim.findUnique({
                where: { domain },
                select: {
                  organizationId: true,
                  verifiedAt: true,
                  organization: {
                    select: {
                      status: true,
                      ssoSettings: {
                        select: {
                          enforceSSO: true,
                          allowedEmailDomains: true,
                        },
                      },
                    },
                  },
                },
              });
              // Unverified domain claims (no DNS TXT proof) must NOT
              // gate session SSO enforcement — same rationale as
              // /api/auth/sso/domain-check. Without this, a malicious
              // OWNER could claim a public domain and force-reject
              // unrelated users' sessions.
              if (
                !claim ||
                !claim.verifiedAt ||
                !claim.organization ||
                claim.organization.status !== "ACTIVE" ||
                !claim.organization.ssoSettings?.enforceSSO
              ) {
                return null;
              }
              const allowed =
                claim.organization.ssoSettings.allowedEmailDomains;
              if (allowed.length > 0 && !allowed.includes(domain)) {
                return null;
              }
              const rows = await prisma.ssoProvider.findMany({
                where: { organizationId: claim.organizationId },
                select: { providerId: true },
              });
              return {
                organizationId: claim.organizationId,
                registeredProviderIds: rows.map((r) => r.providerId),
              };
            },
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
      };

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
        } catch {
          // Unique-constraint race — safe to ignore.
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
              logo: true,
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
          organizationLogo: m.organization.logo,
          role: m.role,
          departmentLabel: m.departmentLabel,
          canSponsor: m.organization.canSponsor,
          canHost: m.organization.canHost,
          fundingSource: m.organization.billingAccount?.fundingSource ?? null,
          walletBalance: m.organization.billingAccount?.walletBalance ?? null,
        }));

      // SSO enforcement: mark sessions that bypassed SSO for enforced domains.
      //
      // An account satisfies enforcement only if `account.providerId` matches
      // one of the `ssoProvider.providerId` rows registered for the enforcing
      // org. Checking against `providerId != "credential"` is NOT enough —
      // that would treat a personal Google or GitHub OAuth account as a valid
      // SSO sign-in, bypassing the policy entirely.
      let ssoEnforcementFailed = false;
      try {
        const email = user.email;
        const domain = email?.split("@")[1]?.toLowerCase();
        if (domain) {
          // Mirror `session.create.before` / `domain-check` lookup: use
          // OrgDomainClaim as the source of truth, honour allowlist if
          // present, skip inactive orgs. Keeping a SINGLE enforcement
          // path fixes issue where credential-signin and read-time
          // reconciliation could disagree on who counts as "enforced".
          const claim = await prisma.orgDomainClaim.findUnique({
            where: { domain },
            select: {
              organizationId: true,
              organization: {
                select: {
                  status: true,
                  ssoSettings: {
                    select: {
                      enforceSSO: true,
                      allowedEmailDomains: true,
                    },
                  },
                },
              },
            },
          });
          const allowed =
            claim?.organization?.ssoSettings?.allowedEmailDomains ?? [];
          const isEnforced =
            !!claim &&
            claim.organization?.status === "ACTIVE" &&
            !!claim.organization?.ssoSettings?.enforceSSO &&
            (allowed.length === 0 || allowed.includes(domain));
          if (isEnforced) {
            const registeredProviders = await prisma.ssoProvider.findMany({
              where: { organizationId: claim.organizationId },
              select: { providerId: true },
            });
            const validProviderIds = registeredProviders.map((p) => p.providerId);
            // Fail-open if no providers configured yet — matches
            // `shouldRejectSession`'s behaviour. Without this, a
            // half-configured org would flag every session as failed.
            if (validProviderIds.length > 0) {
              const linkedViaSSO = await prisma.account.findFirst({
                where: {
                  userId: user.id,
                  providerId: { in: validProviderIds },
                },
                select: { id: true },
              });
              if (!linkedViaSSO) ssoEnforcementFailed = true;
            }
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
