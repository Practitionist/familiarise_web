/**
 * The database tier: `__tests__/db/**\/*.db.test.ts` against real Postgres.
 * Only CI's db-guards job runs it (`npx jest -c jest.db.config.ts`), and the
 * guard refuses any database but that job's disposable localhost /ci one.
 */
import type { Config } from "jest";

export default async function dbTierConfig(): Promise<Config> {
  // Jest loads configs with Node's type stripping, which needs the `.ts` extension a static import can't carry here.
  const {
    default: baseConfig,
    DB_TIER_PATTERNS,
  }: { default: () => Promise<Config>; DB_TIER_PATTERNS: string[] } =
    await import(new URL("./jest.config.ts", import.meta.url).href);
  const base = await baseConfig();
  return {
    ...base,
    testEnvironment: "node",
    testMatch: ["<rootDir>/__tests__/db/**/*.db.test.ts"],
    testPathIgnorePatterns: (base.testPathIgnorePatterns ?? []).filter(
      (pattern) => !DB_TIER_PATTERNS.includes(pattern),
    ),
    // Suites share one database and race inside a test, never across files.
    maxWorkers: 1,
    testTimeout: 30_000,
    collectCoverage: false,
    coverageThreshold: undefined,
    globalSetup: "<rootDir>/__tests__/db/guard.ts",
    setupFilesAfterEnv: [
      ...(base.setupFilesAfterEnv ?? []),
      "<rootDir>/__tests__/db/setup.ts",
    ],
  };
}
