import NextAuth, { DefaultSession, DefaultUser } from "next-auth";
import { JWT } from "next-auth/jwt";

declare module "next-auth" {
  /**
   * Extends the default session interface with custom fields
   */
  interface Session extends DefaultSession {
    user: {
      id: string;
      emailVerified: boolean | null;
      phone: string;
      address: string;
      onboardingCompleted: boolean;
      role: string;
      currentTimezone: string;
      consultantProfileId?: string;
      consulteeProfileId?: string;
      staffProfileId?: string;
    } & DefaultSession["user"];
  }

  /**
   * Extends the default user interface with custom fields
   */
  interface User extends DefaultUser {
    onboardingCompleted: boolean;
    role: string;
    phone: string | null;
    address: string | null;
    currentTimezone: string | null;
    consultantProfileId?: string;
    consulteeProfileId?: string;
    staffProfileId?: string;
  }
}

declare module "next-auth/jwt" {
  /**
   * Extends the default JWT interface with custom fields
   */
  interface JWT {
    onboardingCompleted: boolean;
    role: string;
    consultantProfileId?: string;
    consulteeProfileId?: string;
    staffProfileId?: string;
  }
}