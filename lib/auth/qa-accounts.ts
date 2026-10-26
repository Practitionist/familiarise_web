import { z } from "zod";
import { isOperatorRole } from "@/lib/auth/operator-session-policy";

/** RFC 2606 reserved domain: nothing is delivered there, so no reset can land. */
export const QA_OPERATOR_DOMAIN = "qa.familiarise.invalid";

/** Seeded QA operators that sign in without TOTP off production. */
const QA_OPERATOR_EMAILS: ReadonlySet<string> = new Set([
  `qa-admin-2@${QA_OPERATOR_DOMAIN}`,
  `qa-staff-1@${QA_OPERATOR_DOMAIN}`,
  `qa-staff-3@${QA_OPERATOR_DOMAIN}`,
  `qa-staff-4@${QA_OPERATOR_DOMAIN}`,
]);

/** True for a listed QA operator address on the reserved domain. */
export function isQaOperatorEmail(email: string | null | undefined): boolean {
  const normalized = email?.trim().toLowerCase();
  return (
    !!normalized &&
    normalized.endsWith(`@${QA_OPERATOR_DOMAIN}`) &&
    QA_OPERATOR_EMAILS.has(normalized)
  );
}

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
  return isQaOperatorEmail(user.email);
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
