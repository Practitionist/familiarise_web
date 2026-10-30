/**
 * Netlify sets `NETLIFY=true` on the build machine only; functions see just
 * URL, SITE_NAME and SITE_ID at runtime. The runtime checks keyed on it (the
 * cron lease cap, the pool guard) therefore work
 * only because next.config.mjs inlines it and each check reads it as a literal
 * `process.env.NETLIFY`, which is what the build replaces. Read as source: the
 * config wraps its export in withSentryConfig and cannot be imported here.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

const read = (file: string) =>
  readFileSync(path.join(process.cwd(), file), "utf8");

const envBlock =
  /\n {2}env:\s*\{([\s\S]*?)\n {2}\},/.exec(read("next.config.mjs"))?.[1] ?? "";

it("inlines NETLIFY into the server build when the build runs on Netlify", () => {
  expect(envBlock).toMatch(/NEXT_PUBLIC_SENTRY_BRANCH/);
  expect(envBlock).toMatch(
    /process\.env\.NETLIFY\s*\?\s*\{\s*NETLIFY:\s*process\.env\.NETLIFY\s*\}/,
  );
});

it.each(["lib/cron/with-cron-lock.ts", "lib/prisma.ts"])(
  "%s reads NETLIFY as a literal the build can replace",
  (file) => {
    expect(read(file)).toMatch(/process\.env\.NETLIFY\b/);
  },
);
