/**
 * This file contains the configuration options for NextAuth.js authentication.
 * It sets up the authentication providers, session handling, and callback functions.
 */

import prisma from "@/lib/prisma";
import { PrismaAdapter } from "@next-auth/prisma-adapter";
import { Account, NextAuthOptions, Session, User } from "next-auth";
import { JWT } from "next-auth/jwt";
import GitHubProvider from "next-auth/providers/github";
import GoogleProvider from "next-auth/providers/google";
import FacebookProvider from "next-auth/providers/facebook";
import CredentialsProvider from "next-auth/providers/credentials";
import bcrypt from "bcrypt";
import { sendAccountLinkedEmail } from "@/lib/email";

/**
 * NextAuth options configuration
 */
const authOptions: NextAuthOptions = {
  // Use PrismaAdapter for database integration
  adapter: PrismaAdapter(prisma),

  // Configure authentication providers
  providers: [
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID ?? "",
      clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
    }),
    GitHubProvider({
      clientId: process.env.GITHUB_ID ?? "",
      clientSecret: process.env.GITHUB_SECRET ?? "",
    }),
    FacebookProvider({
      clientId: process.env.FACEBOOK_CLIENT_ID ?? "",
      clientSecret: process.env.FACEBOOK_CLIENT_SECRET ?? "",
    }),
    CredentialsProvider({
      name: "Credentials",
      credentials: {
        email: {
          label: "Email",
          type: "email",
          placeholder: "jsmith@example.com",
        },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        if (!credentials?.email || !credentials?.password) {
          return null;
        }

        const user = await prisma.user.findUnique({
          where: { email: credentials.email },
        });

        if (!user || !user.password) {
          return null;
        }

        const isValidPassword = await bcrypt.compare(
          credentials.password,
          user.password,
        );

        if (!isValidPassword) {
          return null;
        }

        const { password, ...userWithoutPassword } = user;
        return userWithoutPassword as any;
      },
    }),
  ],

  // Set session strategy to JWT
  session: { strategy: "jwt" },

  // Configure JWT options
  jwt: {
    maxAge: 30 * 24 * 60 * 60, // 30 days
    secret: process.env.JWT_SECRET!,
  },

  // Set NextAuth secret
  secret: process.env.NEXTAUTH_SECRET!,

  // Define callback functions
  callbacks: {
    /**
     * Callback function for sign-in
     * @param {Object} params - Contains the user, account, and profile objects
     * @returns {boolean} - Whether the sign-in is allowed
     */
    async signIn({
      user,
      account,
      profile,
    }: {
      user: User;
      account: Account | null;
      profile?: any;
    }): Promise<boolean> {
      // Only proceed for OAuth sign-ins
      if (account && account.provider !== "credentials" && user.email) {
        // Check if there's an existing user with this email
        const existingUser = await prisma.user.findUnique({
          where: { email: user.email },
          include: { accounts: true },
        });

        // If user exists but doesn't have an account with this provider
        if (existingUser && account.provider && account.providerAccountId) {
          // Check if they already have an account for this provider
          const existingAccount = existingUser.accounts.find(
            (acc) => acc.provider === account.provider,
          );

          // If they don't have an account for this provider, link it
          if (!existingAccount) {
            await prisma.account.create({
              data: {
                userId: existingUser.id,
                type: account.type,
                provider: account.provider,
                providerAccountId: account.providerAccountId,
                refresh_token: account.refresh_token,
                access_token: account.access_token,
                expires_at: account.expires_at,
                token_type: account.token_type,
                scope: account.scope,
                id_token: account.id_token,
                session_state: account.session_state,
              },
            });
          }

          // Update user information with any new profile data
          if (profile) {
            await prisma.user.update({
              where: { id: existingUser.id },
              data: {
                // Only update image if not already set
                image: existingUser.image || user.image,
                // Only update name if not already set
                name: existingUser.name || user.name,
              },
            });
          }

          // Use existing user for sign-in
          user.id = existingUser.id;
          return true;
        }
      }

      return !!user;
    },

    /**
     * Callback function for JWT token creation and update
     * @param {Object} params - Contains token, user, account, trigger, and session information
     * @returns {Promise<JWT>} - Updated token object
     */
    async jwt({
      token,
      user,
      account,
      trigger,
      session,
    }: {
      token: JWT;
      user: User | undefined;
      account: Account | null;
      trigger?: "update" | "signIn" | "signUp";
      session?: any;
    }): Promise<JWT> {
      if (trigger === "update" && session?.user) {
        // Update token with new session data
        // This is used to update the session when the user's role changes
        token.onboardingCompleted = session.user.onboardingCompleted;
        token.role = session.user.role;
        token.consultantProfileId = session.user.consultantProfileId;
        token.consulteeProfileId = session.user.consulteeProfileId;
        token.staffProfileId = session.user.staffProfileId;
      } else if (user) {
        // Set user ID in token
        token.sub = user.id;

        try {
          // Fetch user data from database
          const dbUser = await prisma.user.findUnique({
            where: { id: user.id },
            select: {
              onboardingCompleted: true,
              role: true,
              consultantProfile: { select: { id: true } },
              consulteeProfile: { select: { id: true } },
              staffProfile: { select: { id: true } },
            },
          });

          if (dbUser) {
            // Update token with user data
            token.onboardingCompleted = dbUser.onboardingCompleted ?? false;
            token.role = dbUser.role ?? "";
            token.consultantProfileId =
              dbUser.consultantProfile?.id ?? undefined;
            token.consulteeProfileId = dbUser.consulteeProfile?.id ?? undefined;
            token.staffProfileId = dbUser.staffProfile?.id ?? undefined;
          }
        } catch (error) {
          console.error("Error fetching user data in jwt callback:", error);
          // Set default values if database query fails
          token.onboardingCompleted = false;
          token.role = "";
        }
      } else if (account?.providerAccountId) {
        // Set account ID in token
        token.accountId = account.providerAccountId;
      }
      return token;
    },

    /**
     * Callback function for session creation and update
     * @param {Object} params - Contains session and token information
     * @returns {Promise<Session>} - Updated session object
     */
    async session({
      session,
      token,
    }: {
      session: Session;
      token: JWT;
    }): Promise<Session> {
      if (session?.user && token) {
        // Update session with token data (already cached in JWT from jwt callback)
        // PERFORMANCE FIX: Removed database query that was causing 300-500ms delay on every session check
        // All essential data is already in the JWT token from the jwt callback
        session.user.id = token.sub as string;
        session.user.onboardingCompleted = token.onboardingCompleted as boolean;
        session.user.role = token.role as string;
        session.user.consultantProfileId = token.consultantProfileId as
          | string
          | undefined;
        session.user.consulteeProfileId = token.consulteeProfileId as
          | string
          | undefined;
        session.user.staffProfileId = token.staffProfileId as
          | string
          | undefined;

        // Use existing session data for name/email/image (already populated by NextAuth)
        // Additional fields like phone/address/timezone can be fetched on demand
        // in components that specifically need them, rather than on every session check
      }
      return session;
    },

    /**
     * Callback function for redirect after authentication
     * @param {Object} params - Contains the base URL and callback URL
     * @returns {Promise<string>} - Redirect URL
     */
    async redirect({
      url,
      baseUrl,
    }: {
      url: string;
      baseUrl: string;
    }): Promise<string> {
      // Check if there's a callbackUrl in the URL parameters
      try {
        const urlObj = new URL(url);
        const callbackUrl = urlObj.searchParams.get("callbackUrl");

        // If there's a valid callback URL and it's from the same origin, use it
        if (callbackUrl) {
          const callbackUrlObj = new URL(callbackUrl, baseUrl);
          if (callbackUrlObj.origin === baseUrl) {
            console.log(`Redirecting to callback URL: ${callbackUrl}`);
            return callbackUrl;
          }
        }
      } catch (error) {
        console.warn("Error parsing redirect URL:", error);
      }

      // Default redirect to explore page
      return `${baseUrl}/explore/experts`;
    },
  },

  // Enable debug in development
  debug: process.env.NODE_ENV === "development",

  // Add pages configuration
  pages: {
    signIn: "/auth/signin",
  },

  // Custom events handlers
  events: {
    async linkAccount({ user, account }) {
      // This event is triggered when a new account is linked to a user
      console.log(`Account linked: ${account.provider} for user ${user.email}`);

      // Send email notification when a new account is linked
      if (user.email) {
        try {
          console.log(
            `Sending account linked email to: ${user.email} for provider: ${account.provider}`,
          );
          const emailResult = await sendAccountLinkedEmail({
            email: user.email,
            name: user.name || "User",
            provider: account.provider || "Social Provider",
          });

          if (!emailResult.success) {
            console.error(
              "[LINK_ACCOUNT] Account linked email failed:",
              emailResult.error,
            );
          } else {
            console.log(
              "[LINK_ACCOUNT] Account linked email sent successfully",
            );
          }
        } catch (error) {
          console.error(
            "[LINK_ACCOUNT] Failed to send account linked email:",
            error,
          );
          // Don't block the account linking process if email fails
        }
      }
    },
  },
};

export default authOptions;
