import { PrismaAdapter } from "@next-auth/prisma-adapter";
import { NextAuthOptions, User } from "next-auth";
import { JWT } from "next-auth/jwt";
import GitHubProvider from "next-auth/providers/github";
import GoogleProvider from "next-auth/providers/google";
import { Account, Session } from "next-auth";
import prisma from "@/lib/prisma";

const authOptions: NextAuthOptions = {
  adapter: PrismaAdapter(prisma),
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
  session: { strategy: "jwt" },
  jwt: {
    maxAge: 30 * 24 * 60 * 60, // 30 days
    secret: process.env.JWT_SECRET!,
  },

  callbacks: {
    async signIn({ user }: { user: User }) {
      return !!user;
    },

    async jwt({ token, user, account }: { token: JWT; user: User | undefined; account: Account | null }) {
      if (user) {
        token.sub = user.id;
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

        token.onboardingCompleted = dbUser?.onboardingCompleted;
        token.role = dbUser?.role;
        token.consultantProfileId = dbUser?.consultantProfile?.id;
        token.consulteeProfileId = dbUser?.consulteeProfile?.id;
        token.staffProfileId = dbUser?.staffProfile?.id;
      } else if (account?.providerAccountId) {
        token.accountId = account.providerAccountId;
      }
      return token;
    },

    async session({ session, token }: { session: Session; token: JWT }) {
      if (session?.user && token.sub) {
        session.user.id = token.sub;

        const user = await prisma.user.findUnique({
          where: { email: session.user.email ?? "" },
          select: {
            email: true,
            name: true,
            image: true,
            phone: true,
            address: true,
            onboardingCompleted: true,
            role: true,
            currentTimezone: true,
            consultantProfile: { select: { id: true } },
            consulteeProfile: { select: { id: true } },
            staffProfile: { select: { id: true } },
          },
        });

        if (user) {
          Object.assign(session.user, {
            ...user,
            phone: user.phone ?? "",
            address: user.address ?? "",
            onboardingCompleted: user.onboardingCompleted ?? false,
            role: user.role ?? "CONSULTEE",
            currentTimezone: user.currentTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
            consultantProfileId: user.consultantProfile?.id,
            consulteeProfileId: user.consulteeProfile?.id,
            staffProfileId: user.staffProfile?.id,
          });
        }
      }
      return session;
    },

    async redirect({ baseUrl }: { baseUrl: string }) {
      return `${baseUrl}/explore/experts`;
    },
  },
};

export default authOptions;