import { betterAuth } from "better-auth";
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
    },
  },

  databaseHooks: {
    user: {
      create: {
        after: async (user) => {
          try {
            // Create ConsulteeProfile
            const consulteeProfile = await prisma.consulteeProfile.create({
              data: { userId: user.id },
            });

            // Update user with consulteeProfileId
            await prisma.user.update({
              where: { id: user.id },
              data: { consulteeProfileId: consulteeProfile.id },
            });

            // Create CookiePreference
            await prisma.cookiePreference.create({
              data: { userId: user.id },
            });

            // Create NotificationPreference
            await prisma.notificationPreference.create({
              data: { userId: user.id },
            });

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
    // Pre-MVP cap of 5 orgs per user. Default creator role is ORG_OWNER —
    // mirrored at the typed sibling layer (OrganizationMemberProfile).
    organization({
      organizationLimit: 5,
      creatorRole: "ORG_OWNER",
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
      };

      // SSO membership sync: BetterAuth SSO auto-provisioning creates a
      // BetterAuth `member` row but NOT the typed `OrganizationMemberProfile`
      // sibling the app requires. Auto-repair missing profiles here so
      // SSO-provisioned users get access on first session load.
      const bareMembers = await prisma.member.findMany({
        where: {
          userId: user.id,
          organizationMemberProfile: null, // no typed sibling yet
        },
        select: {
          id: true,
          organizationId: true,
          role: true,
          organization: {
            select: {
              organizationProfile: {
                select: {
                  id: true,
                  ssoSettings: { select: { defaultRoleForAutoJoin: true } },
                },
              },
            },
          },
        },
      });
      for (const bm of bareMembers) {
        const orgProfile = bm.organization?.organizationProfile;
        if (!orgProfile) continue;
        const defaultRole =
          orgProfile.ssoSettings?.defaultRoleForAutoJoin ?? "ORG_LEARNER";
        try {
          await prisma.organizationMemberProfile.create({
            data: {
              memberId: bm.id,
              organizationProfileId: orgProfile.id,
              role: defaultRole,
              status: "ACTIVE",
            },
          });
        } catch {
          // Unique constraint race — profile was created between the check
          // and now (concurrent session loads). Safe to ignore.
        }
      }

      // Enterprise: load the user's active org memberships so the OrgSwitcher
      // and any org-aware route can read them from the session without an
      // extra DB roundtrip. Cheap query — joined to the typed sibling profile
      // for the role enum and the parent OrganizationProfile/Organization.
      const memberships = await prisma.organizationMemberProfile.findMany({
        where: {
          status: "ACTIVE",
          member: { userId: user.id },
        },
        select: {
          role: true,
          organizationProfileId: true,
          organizationProfile: {
            select: {
              kind: true,
              status: true,
              organization: {
                select: { id: true, name: true, slug: true, logo: true },
              },
            },
          },
        },
      });

      const organizationMemberships = memberships
        .filter((m) => m.organizationProfile.status === "ACTIVE")
        .map((m) => ({
          organizationId: m.organizationProfile.organization.id,
          organizationName: m.organizationProfile.organization.name,
          organizationSlug: m.organizationProfile.organization.slug,
          organizationLogo: m.organizationProfile.organization.logo,
          organizationProfileId: m.organizationProfileId,
          kind: m.organizationProfile.kind,
          role: m.role,
        }));

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
          organizationMemberships,
        },
        session,
      };
    }),
    nextCookies(), // Must be last
  ],
});

export type Session = typeof auth.$Infer.Session;
