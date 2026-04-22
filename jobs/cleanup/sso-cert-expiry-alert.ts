/**
 * SSO Cert Expiry Alert Job (GitHub Actions Wrapper)
 *
 * Thin wrapper around scripts/cleanup/sso-cert-expiry-alert.ts.
 *
 * Runs daily at 08:30 IST (03:00 UTC) via
 * .github/workflows/sso-cert-expiry-alert.yml — slot picked to avoid
 * overlap with the 07:30, 08:00, and 09:30-IST cron windows.
 */

import fs from "fs";
import {
  runSsoCertExpiryAlert,
  disconnectDatabase,
  type SsoCertExpiryAlertResult,
} from "../../scripts/cleanup/sso-cert-expiry-alert";
import { abortIfMaintenance } from "../../lib/maintenance-cron";

function outputToGitHubActions(result: SsoCertExpiryAlertResult): void {
  if (!process.env.GITHUB_ACTIONS) return;

  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    const outputs = [
      `scanned=${result.scanned}`,
      `alerted=${result.alerted}`,
      `parse_failures=${result.parseFailures}`,
      `success=${result.success}`,
    ].join("\n");
    fs.appendFileSync(outputFile, outputs + "\n");
  }

  if (!result.success) {
    console.log(
      `::error::SSO cert expiry alert completed with errors: ${result.errors.join("; ")}`,
    );
  }
}

async function main(): Promise<void> {
  await abortIfMaintenance("sso-cert-expiry-alert");
  console.log("🔐 Starting SSO cert expiry alert job...");
  console.log(`Timestamp: ${new Date().toISOString()}`);

  try {
    const result = await runSsoCertExpiryAlert();

    console.log("\n📊 Alert Results:");
    console.log(`   Scanned: ${result.scanned}`);
    console.log(`   Alerted: ${result.alerted}`);
    console.log(`   Parse failures: ${result.parseFailures}`);
    console.log(`   Success: ${result.success}`);

    if (result.errors.length > 0) {
      console.log("\n⚠️ Errors:");
      result.errors.forEach((e) => console.log(`   - ${e}`));
    }

    outputToGitHubActions(result);

    if (!result.success) {
      process.exit(1);
    }
  } catch (error) {
    console.error("❌ Fatal error in SSO cert expiry alert:", error);
    process.exit(1);
  } finally {
    await disconnectDatabase();
  }
}

main();
