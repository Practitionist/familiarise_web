/**
 * @jest-environment node
 */
/**
 * Netlify ticket #1112198 — the keep-warm scheduled function fires N PARALLEL
 * unique-key pings at the zero-import probe every four minutes. Jest has no
 * transform for `.mts`, so the file is transpiled here like cron-tick's test.
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

function loadKeepWarm(): {
  keepWarmConcurrency: (raw: string | undefined) => number;
  keepWarmUrls: (baseUrl: string, n: number) => string[];
  KEEP_WARM_PATH: string;
  config: { schedule: string };
} {
  const file = path.join(
    __dirname,
    "..",
    "..",
    "netlify",
    "functions",
    "keep-warm.mts",
  );
  const { outputText } = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  });
  const mod = { exports: {} as ReturnType<typeof loadKeepWarm> };
  vm.runInNewContext(outputText, { module: mod, exports: mod.exports });
  return mod.exports;
}

describe("keep-warm", () => {
  const { keepWarmConcurrency, keepWarmUrls, KEEP_WARM_PATH, config } =
    loadKeepWarm();

  it("runs every four minutes, inside the ~5-minute reclaim window Netlify described", () => {
    expect(config.schedule).toBe("*/4 * * * *");
  });

  it("defaults to three, honours 0 as off, and ignores nonsense", () => {
    expect(keepWarmConcurrency(undefined)).toBe(3);
    expect(keepWarmConcurrency("0")).toBe(0);
    expect(keepWarmConcurrency("5")).toBe(5);
    expect(keepWarmConcurrency("banana")).toBe(3);
    expect(keepWarmConcurrency("99")).toBe(3);
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
