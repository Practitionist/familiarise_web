import { z } from "zod";
import { isOperatorRole } from "@/lib/auth/operator-session-policy";

/**
 * Seeded QA operators that sign in without TOTP off production. Exact
 * addresses only: their domains are public mail hosts, so no suffix is safe.
 */
const QA_OPERATOR_EMAILS: ReadonlySet<string> = new Set([
  "patrick.brown@gmail.com",
  "maria.brown@gmail.com",
  "nathan.brown@hotmail.com",
  "natalie.brown@yahoo.com",
]);

/** The non-production deploy environments; unset or anything else enforces 2FA. */
const nonProductionEnvironment = z.enum(["preview", "development"]);

export type QaExemptionEnv = { sentryEnvironment: string | undefined };

type OperatorUser = {
  role?: string | null;
  email?: string | null;
  twoFactorEnabled?: boolean | null;
};

/** The build-inlined deploy environment: `production` on the production context. */
export function deployEnvironment(): QaExemptionEnv {
  return { sentryEnvironment: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT };
}

/**
 * True only for a designated QA operator on a non-production deployment. Every
 * deployment shares the production database, so real operators always enrol.
 */
export function isQaOperatorExemptFrom2fa(
  user: OperatorUser,
  env: QaExemptionEnv,
): boolean {
  if (!isOperatorRole(user.role)) return false;
  if (!nonProductionEnvironment.safeParse(env.sentryEnvironment).success) {
    return false;
  }
  const email = user.email?.trim().toLowerCase();
  return !!email && QA_OPERATOR_EMAILS.has(email);
}

/** True when an operator must enrol 2FA before any operator power. */
export function needsOperatorTwoFactor(
  user: OperatorUser,
  env: QaExemptionEnv = deployEnvironment(),
): boolean {
  return (
    isOperatorRole(user.role) &&
    user.twoFactorEnabled !== true &&
    !isQaOperatorExemptFrom2fa(user, env)
  );
}
