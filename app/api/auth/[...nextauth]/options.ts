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

/**
 * NextAuth options configuration
 */
const authOptions: NextAuthOptions = {
  // Use PrismaAdapter for database integration
  adapter: PrismaAdapter(prisma),

  // Configure authentication providers
  providers: [
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    }),
    GitHubProvider({
      clientId: process.env.GITHUB_CLIENT_ID!,
      clientSecret: process.env.GITHUB_CLIENT_SECRET!,
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
     * @param {Object} params - Contains the user object
     * @returns {boolean} - Whether the sign-in is allowed
     */
    async signIn({ user }: { user: User }): Promise<boolean> {
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
        // Update session with token data
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

        try {
          // Fetch additional user data from database
          const user = await prisma.user.findUnique({
            where: { email: session.user.email ?? "" },
            select: {
              email: true,
              name: true,
              image: true,
              phone: true,
              address: true,
              currentTimezone: true,
            },
          });

          if (user) {
            // Merge fetched user data with session
            Object.assign(session.user, {
              ...user,
              phone: user.phone ?? "",
              address: user.address ?? "",
              currentTimezone:
                user.currentTimezone ??
                Intl.DateTimeFormat().resolvedOptions().timeZone,
            });
          }
        } catch (error) {
          console.error("Error fetching user data in session callback:", error);
          // Keep existing session data if database query fails
        }
      }
      return session;
    },

    /**
     * Callback function for redirect after authentication
     * @param {Object} params - Contains the base URL
     * @returns {Promise<string>} - Redirect URL
     */
    async redirect({ baseUrl }: { baseUrl: string }): Promise<string> {
      return `${baseUrl}/explore/experts`;
    },
  },
};

export default authOptions;
