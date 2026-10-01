/**
 * Create the FIRST platform admin. Every later operator is added from the
 * Team page (POST /api/admin/team/members), which is audited; this script
 * refuses once any ADMIN exists. Same creation path as that route
 * (lib/auth/operators.ts): no password is ever chosen or printed here. The
 * person gets a set-password email, signs in, and enrols 2FA.
 *
 *   npx tsx -r dotenv/config scripts/bootstrap-admin.ts \
 *     --email you@example.com --name "Your Name" [--print-link]
 *
 * --print-link prints the set-password link instead of emailing it, for
 * local development without a mail key. Refused in production.
 */
import "dotenv/config";
import { randomBytes } from "node:crypto";

import prisma from "../lib/prisma";
import { auth } from "../lib/auth";
import { createOperator, sendOperatorSetupLink } from "../lib/auth/operators";
import { getAppUrl } from "../lib/url";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main(): Promise<void> {
  const email = arg("--email");
  const name = arg("--name");
  const printLink = process.argv.includes("--print-link");
  if (!email || !name) {
    throw new Error(
      'Usage: --email <address> --name "<full name>" [--print-link]',
    );
  }
  if (printLink && process.env.NODE_ENV === "production") {
    throw new Error("--print-link is for local development only.");
  }
  const admin = await prisma.user.findFirst({
    where: { role: "ADMIN" },
    select: { email: true },
  });
  if (admin) {
    throw new Error(
      `An admin already exists (${admin.email}). Add operators from the Team page.`,
    );
  }

  const operator = await createOperator({ email, name, role: "ADMIN" });
  console.log(`Created ADMIN ${operator.email} (${operator.userId}).`);

  if (printLink) {
    // The same verification row requestPasswordReset writes, without the email.
    const ctx = await auth.$context;
    const token = randomBytes(24).toString("base64url");
    await ctx.internalAdapter.createVerificationValue({
      identifier: `reset-password:${token}`,
      value: operator.userId,
      expiresAt: new Date(Date.now() + 30 * 60 * 1000),
    });
    console.log(`Set-password link (30 minutes, single use):`);
    console.log(`  ${getAppUrl()}/auth/reset-password?token=${token}`);
  } else {
    await sendOperatorSetupLink(operator.email);
    console.log(`Set-password link emailed to ${operator.email}.`);
  }
}

main()
  .catch((error: unknown) => {
    console.error(
      `✗ ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
