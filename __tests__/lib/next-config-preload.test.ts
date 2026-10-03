/**
 * Regression guard for the Netlify `___netlify-server-handler` cold-start
 * event-loop stall (#1124) and V8 heap OOM (`504 Inactivity Timeout`).
 *
 * `@netlify/plugin-nextjs` instantiates `NextNodeServer` with `minimalMode: false`.
 * Unless both `preloadEntriesOnStart` and `appDocumentPreloading` are explicitly
 * `false` in `next.config.mjs`, Next.js eagerly calls `unstable_preloadEntries()`
 * across all 600+ routes (1.67M `webpackRequire` calls) on cold start, starving
 * the Node event loop for 20–34s and exhausting Node 22's 512 MB V8 heap ceiling
 * on 1024 MB AWS Lambda containers.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

const src = readFileSync(path.join(process.cwd(), "next.config.mjs"), "utf8");

const experimentalBlock =
  /experimental:\s*\{([\s\S]*?)\n\s{2}\},/.exec(src)?.[1] ?? "";

const serverExternalBlock =
  /serverExternalPackages:\s*\[([\s\S]*?)\]/.exec(src)?.[1] ?? "";

describe("next.config.mjs — serverless cold-start preload guards", () => {
  it("explicitly sets preloadEntriesOnStart: false in experimental", () => {
    expect(experimentalBlock).toMatch(/preloadEntriesOnStart\s*:\s*false/);
  });

  it("explicitly sets appDocumentPreloading: false in experimental", () => {
    expect(experimentalBlock).toMatch(/appDocumentPreloading\s*:\s*false/);
  });

  it("externalizes @novu/api on the server to keep server chunks slim", () => {
    expect(serverExternalBlock).toMatch(/"@novu\/api"/);
  });
});
