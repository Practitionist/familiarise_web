/**
 * Prints the current authenticator code of a seeded QA operator that enrols
 * TOTP, derived from BETTER_AUTH_SECRET exactly as the seed stored it.
 *
 *   npm run qa:totp -- qa-admin-1@qa.familiarise.invalid
 */
import "dotenv/config";

import {
  computeSeedOperatorTotp,
  isSeedTotpOperatorEmail,
} from "../../prisma/seedFiles/seed-two-factor";

const TOTP_STEP_SECONDS = 30;

function main(): void {
  const email = process.argv[2]?.trim().toLowerCase();
  if (!email || !isSeedTotpOperatorEmail(email)) {
    throw new Error(
      "Usage: npm run qa:totp -- <qa-admin-N|qa-staff-N>@qa.familiarise.invalid (a QA operator that enrols TOTP).",
    );
  }
  const now = new Date();
  const remaining =
    TOTP_STEP_SECONDS - (Math.floor(now.getTime() / 1000) % TOTP_STEP_SECONDS);
  console.log(`${computeSeedOperatorTotp(email, now)}  (${remaining}s left)`);
}

try {
  main();
} catch (error: unknown) {
  console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
