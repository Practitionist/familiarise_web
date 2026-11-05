/**
 * Rewrites the TOTP row of every seeded QA operator that must enrol 2FA, so
 * `npm run qa:totp -- <email>` matches what the database stores again. Only
 * qa-(admin|staff)-N on the reserved QA domain outside the exemption list
 * qualify; the 2FA-exempt QA operators and every real operator are refused.
 *
 *   npx tsx -r dotenv/config scripts/auth/repair-qa-operator-2fa.ts [--apply] [email ...]
 *
 * Dry run by default. Needs the BETTER_AUTH_SECRET the deployment uses.
 */
import "dotenv/config";

import prisma from "../../lib/prisma";
import { isOperatorRole } from "../../lib/auth/operator-session-policy";
import { QA_OPERATOR_DOMAIN } from "../../lib/auth/qa-accounts";
import {
  seedOperatorEnrolmentUpdate,
  isSeedTotpOperatorEmail,
  requireAuthSecret,
} from "../../prisma/seedFiles/seed-two-factor";

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const requested = process.argv
    .slice(2)
    .filter((arg) => !arg.startsWith("--"))
    .map((email) => email.trim().toLowerCase());
  const refused = requested.filter((email) => !isSeedTotpOperatorEmail(email));
  if (refused.length > 0) {
    throw new Error(
      `Refused: ${refused.join(", ")} is not a seeded QA operator that enrols TOTP.`,
    );
  }
  requireAuthSecret();

  const candidates = await prisma.user.findMany({
    where: {
      email: requested.length
        ? { in: requested }
        : { endsWith: `@${QA_OPERATOR_DOMAIN}` },
    },
    select: {
      id: true,
      email: true,
      role: true,
      twoFactorEnabled: true,
      twoFactor: {
        select: { failedVerificationCount: true, lockedUntil: true },
      },
    },
    orderBy: { email: "asc" },
  });
  const targets = candidates.filter(
    (user) => isOperatorRole(user.role) && isSeedTotpOperatorEmail(user.email),
  );

  console.log(
    `${apply ? "Applying" : "Dry run (pass --apply to write)"}: ${targets.length} QA operator(s).`,
  );
  for (const user of targets) {
    const state = user.twoFactor
      ? `row present, ${user.twoFactor.failedVerificationCount} failed, locked until ${user.twoFactor.lockedUntil?.toISOString() ?? "never"}`
      : "no row";
    console.log(
      `  ${user.email} (${user.role}, twoFactorEnabled=${user.twoFactorEnabled}, ${state})`,
    );
    if (apply) {
      await prisma.user.update(await seedOperatorEnrolmentUpdate(user));
    }
  }
  const missing = requested.filter(
    (email) => !targets.some((user) => user.email === email),
  );
  if (missing.length > 0) {
    console.log(`  Not found as an operator: ${missing.join(", ")}`);
  }
  console.log(
    apply
      ? "Done. Each operator now verifies with `npm run qa:totp -- <email>`."
      : "Nothing written.",
  );
}

main()
  .catch((error: unknown) => {
    console.error(
      `✗ ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
