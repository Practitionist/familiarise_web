/**
 * Netlify sets `NETLIFY=true` on the build machine only; functions see just
 * URL, SITE_NAME and SITE_ID at runtime. Next bundles see the inlined literal
 * `process.env.NETLIFY`; `netlify/functions/*` are not Next-compiled, so the
 * lease cap and pool guard also accept the runtime `SITE_ID`. Read as source:
 * the config wraps its export in withSentryConfig and cannot be imported here.
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

it("detects Netlify from the inlined NETLIFY or the runtime SITE_ID, both literal", () => {
  const host = read("lib/runtime-host.ts");
  expect(host).toMatch(/process\.env\.NETLIFY\b/);
  expect(host).toMatch(/process\.env\.SITE_ID\b/);
});

it.each(["lib/prisma.ts"])(
  "%s keys its Netlify behaviour on onNetlify()",
  (file) => {
    expect(read(file)).toMatch(/onNetlify\(\)/);
  },
);
