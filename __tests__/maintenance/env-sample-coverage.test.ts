/**
 * @jest-environment node
 */

/**
 * Every environment variable the runtime reads is documented in `.env.sample`,
 * either as an active line or a commented `# KEY=` line, so a deploy never
 * depends on a key nobody wrote down.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../..");
const SOURCE_PATHS = [
  "app",
  "lib",
  "actions",
  "components",
  "jobs",
  "scripts",
  "utils",
  "netlify",
  "prisma",
];

// Keys read through a computed name, which the literal scan cannot see.
const DYNAMIC_KEYS = [
  // lib/prisma.ts pgTimeoutMs names
  "PG_CONNECT_TIMEOUT_MS",
  "PG_QUERY_TIMEOUT_MS",
  "PRISMA_SLOW_QUERY_MS",
  "ALLOCATION_TX_MAX_WAIT_MS",
  "ALLOCATION_TX_TIMEOUT_MS",
  // lib/compliance/lut.ts constants
  "PLATFORM_LUT_NUMBER",
  "PLATFORM_LUT_VALID_TILL",
  // lib/auth/social-providers.ts `${PREFIX}_CLIENT_ID` / `_CLIENT_SECRET`
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  // lib/novu/secret-key.ts
  "NOVU_PRODUCTION_KEY",
  "NOVU_DEVELOPMENT_KEY",
  // jobs/compliance/irp-uploader.ts preflight key array
  "CLEARTAX_API_KEY",
  "CLEARTAX_GSP_TOKEN",
  "PLATFORM_GSTIN",
];

// Set by Netlify, Vercel, Fly, GitHub Actions, Next.js or Node, never by us.
const PLATFORM_KEYS = [
  "NODE_ENV",
  "NETLIFY",
  "CONTEXT",
  "DEPLOY_PRIME_URL",
  "URL",
  "SITE_ID",
  "COMMIT_REF",
  "BRANCH",
  "CI",
  "NEXT_PHASE",
  "NEXT_RUNTIME",
  "AWS_REGION",
  "AWS_LAMBDA_FUNCTION_MEMORY_SIZE",
  "GITHUB_ACTIONS",
  "GITHUB_OUTPUT",
  "GITHUB_REPOSITORY",
  "VERCEL",
  "VERCEL_URL",
  "VERCEL_GIT_COMMIT_SHA",
  "VERCEL_CRON_SECRET",
  "FLY_APP_NAME",
];

const KEY = "[A-Z][A-Z0-9_]*";
// `process.env.X`, `process.env["X"]`, and the `env.X` parameter style.
const READ_PATTERNS = [
  new RegExp(`process\\.env\\.(${KEY})\\b`, "g"),
  new RegExp(`process\\.env\\[\\s*["'](${KEY})["']\\s*\\]`, "g"),
  new RegExp(`(?<![.\\w])env\\.(${KEY})\\b`, "g"),
];

function sourceFiles(target: string): string[] {
  const full = path.join(ROOT, target);
  if (statSync(full).isFile()) return [full];
  return readdirSync(full, { withFileTypes: true }).flatMap((entry) => {
    const child = path.join(full, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "node_modules" || entry.name === "__tests__"
        ? []
        : sourceFiles(path.relative(ROOT, child));
    }
    return /\.(ts|tsx|mts|mjs)$/.test(entry.name) ? [child] : [];
  });
}

// Root-level entry points: middleware, instrumentation*, sentry* and next.config.
const ROOT_FILE =
  /^(middleware|instrumentation.*|sentry.*|next\.config)\.(ts|mts|mjs)$/;

function readKeys(): Set<string> {
  const keys = new Set<string>();
  const rootFiles = readdirSync(ROOT).filter((name) => ROOT_FILE.test(name));
  for (const file of [...SOURCE_PATHS, ...rootFiles].flatMap(sourceFiles)) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (/^\s*(\*|\/\/)/.test(line)) continue;
      for (const pattern of READ_PATTERNS) {
        for (const match of line.matchAll(pattern)) keys.add(match[1]);
      }
    }
  }
  return keys;
}

function documentedKeys(): Set<string> {
  const sample = readFileSync(path.join(ROOT, ".env.sample"), "utf8");
  const keys = new Set<string>();
  for (const match of sample.matchAll(new RegExp(`^#?\\s*(${KEY})=`, "gm"))) {
    keys.add(match[1]);
  }
  return keys;
}

describe(".env.sample coverage", () => {
  it("documents every key the runtime reads", () => {
    const documented = documentedKeys();
    const platform = new Set(PLATFORM_KEYS);
    const missing = [...readKeys(), ...DYNAMIC_KEYS]
      .filter((key) => !platform.has(key) && !documented.has(key))
      .sort();

    expect(missing).toEqual([]);
  });
});
