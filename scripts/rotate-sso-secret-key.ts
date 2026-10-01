/**
 * Re-encrypt every `SsoProvider.oidcConfig` under the current
 * `AUTH_CONFIG_ENCRYPTION_KEY`. Run after rotating the key, with the old key
 * still set as `AUTH_CONFIG_ENCRYPTION_KEY_PREVIOUS`; once it reports zero
 * failures the previous key can be removed.
 *
 *   npx tsx -r dotenv/config scripts/rotate-sso-secret-key.ts
 */
import "dotenv/config";

import prisma from "../lib/prisma";
import { readOidcConfig } from "../lib/prisma-sso-secret-extension";
import { currentKeyId, encryptSecretPayload } from "../lib/sso/secret-crypto";

async function main(): Promise<void> {
  const kid = currentKeyId();
  if (!kid)
    throw new Error("AUTH_CONFIG_ENCRYPTION_KEY is unset or malformed.");

  const rows = await prisma.ssoProvider.findMany({
    where: { oidcConfig: { not: null } },
    select: { id: true, providerId: true, oidcConfig: true },
  });

  let rotated = 0;
  const failed: string[] = [];
  for (const row of rows) {
    const read = readOidcConfig(row);
    if (read.failure) {
      failed.push(`${row.providerId}: ${read.failure}`);
      continue;
    }
    await prisma.ssoProvider.update({
      where: { id: row.id },
      data: { oidcConfig: encryptSecretPayload(read.config) },
    });
    rotated++;
  }

  console.log(
    `Re-encrypted ${rotated} of ${rows.length} providers under kid ${kid}.`,
  );
  if (failed.length > 0) {
    console.error(`Unreadable (left untouched):\n  ${failed.join("\n  ")}`);
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
