import { DefaultSession, DefaultUser } from "next-auth";
import "next-auth/jwt";

// This file has to be included in your tsconfig.json "include" array
// Dont keep it in the root of your project, keep it in a separate folder
// https://github.com/nextauthjs/next-auth/issues/7377#issuecomment-1670760533
export declare module "next-auth" {
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
