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

function loadTicker(): { targetRequest: TargetRequest } {
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
  const mod = { exports: {} as { targetRequest: TargetRequest } };
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
