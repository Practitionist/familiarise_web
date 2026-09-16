/**
 * @jest-environment node
 */

/**
 * #1633 — the ticker's per-target request shape. `reconcile-ledgers` must be
 * asked to resume (never to open a run), carry no `limit` so the route's own
 * soft deadline bounds the chunk, and get its own 20 s timeout, while the
 * money sweeps keep the six-second default and their `limit`. Jest has no
 * transform for `.mts`, so the function file is transpiled here and its
 * exported `targetRequest` called directly, rather than pinned by grepping
 * source text.
 */

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

type TargetRequest = (
  baseUrl: string,
  name: string,
) => { url: string; timeoutMs: number };

function loadTicker(): {
  targetRequest: TargetRequest;
  keepWarmConcurrency: (raw?: string) => number;
  keepWarmUrls: (baseUrl: string, n: number) => string[];
  KEEP_WARM_PATH: string;
} {
  const file = path.join(
    __dirname,
    "..",
    "..",
    "netlify",
    "functions",
    "cron-tick.mts",
  );
  const { outputText } = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  });
  const mod = {
    exports: {} as ReturnType<typeof loadTicker>,
  };
  vm.runInNewContext(outputText, { module: mod, exports: mod.exports });
  return mod.exports;
}

describe("cron-tick targetRequest", () => {
  const { targetRequest } = loadTicker();
  const base = "https://site.test";

  it("resumes the ledger reconcile with no limit and a 20 s timeout", () => {
    expect(targetRequest(base, "reconcile-ledgers")).toEqual({
      url: "https://site.test/api/cleanup/reconcile-ledgers?resume=1",
      timeoutMs: 20_000,
    });
  });

  it("leaves the money sweeps on their limit and the six-second default", () => {
    expect(targetRequest(base, "release-earnings")).toEqual({
      url: "https://site.test/api/cleanup/release-earnings?limit=50",
      timeoutMs: 6_000,
    });
    expect(targetRequest(base, "abandoned-payments")).toEqual({
      url: "https://site.test/api/cleanup/abandoned-payments?limit=10",
      timeoutMs: 6_000,
    });
  });
});

// Netlify ticket #1112198 — parallel keep-warm pings against the zero-import
// probe; N defaults to 5, `0` disables, garbage falls back to the default.
describe("cron-tick keep-warm", () => {
  const { keepWarmConcurrency, keepWarmUrls, KEEP_WARM_PATH } = loadTicker();

  it("defaults to five, honours 0 as off, and ignores nonsense", () => {
    expect(keepWarmConcurrency(undefined)).toBe(5);
    expect(keepWarmConcurrency("0")).toBe(0);
    expect(keepWarmConcurrency("3")).toBe(3);
    expect(keepWarmConcurrency("banana")).toBe(5);
    expect(keepWarmConcurrency("99")).toBe(5);
  });

  it("mints one unique-key probe URL per instance to warm", () => {
    const urls = keepWarmUrls("https://example.test", 3);
    expect(urls).toHaveLength(3);
    for (const url of urls) {
      expect(url.startsWith(`https://example.test${KEEP_WARM_PATH}?k=`)).toBe(
        true,
      );
    }
    expect(new Set(urls).size).toBe(3);
  });
});
