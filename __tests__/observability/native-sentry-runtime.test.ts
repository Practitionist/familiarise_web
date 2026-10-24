/** @jest-environment node */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

it("captures, scrubs and flushes native ESM job telemetry through the shared SDK policy", () => {
  const root = path.resolve(__dirname, "../..");
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), "native-sentry-test-"),
  );
  const modules = [
    "sentry.shared.config",
    "lib/observability/expected",
    "lib/observability/sentry-scrubber",
    "lib/observability/report",
    "lib/observability/job-sentry",
    "lib/cron/cron-lock-errors",
    "lib/db/pg-errors",
    "utils/env",
  ];
  try {
    fs.symlinkSync(
      fs.realpathSync(path.join(root, "node_modules")),
      path.join(temporary, "node_modules"),
      "dir",
    );
    for (const name of modules) {
      const source = fs
        .readFileSync(path.join(root, `${name}.ts`), "utf8")
        .replace(
          /(["'])@\/([^"']+)\1/g,
          (_match, quote: string, module: string) => {
            const url = pathToFileURL(path.join(temporary, `${module}.mjs`));
            return `${quote}${url.href}${quote}`;
          },
        );
      const output = ts.transpileModule(source, {
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.ES2022,
        },
      }).outputText;
      const destination = path.join(temporary, `${name}.mjs`);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, output);
    }
    const driver = `
      import assert from "node:assert/strict";
      import { createRequire } from "node:module";
      import { initSentry } from "./sentry.shared.config.mjs";
      import { flushJobSentry } from "./lib/observability/job-sentry.mjs";
      import { reportSentryError } from "./lib/observability/report.mjs";
      const envelopes = [];
      const warnings = [];
      globalThis.fetch = async () => { throw new Error("Network forbidden in SDK regression"); };
      console.warn = (...args) => { warnings.push(String(args[0])); };
      console.error = () => {};
      initSentry({
        enabled: true,
        dsn: "https://public@example.invalid/1",
        defaultIntegrations: false,
        tracesSampleRate: 0,
        transport: () => ({
          send: async envelope => { envelopes.push(envelope); return {}; },
          flush: async () => true,
        }),
      });
      const frameworkSentry = createRequire(import.meta.url)("@sentry/nextjs");
      frameworkSentry.setUser({ id: "native-sdk-user" });
      frameworkSentry.setTag("native-context", "shared");
      reportSentryError(new Error("native SDK failure for synthetic@example.test"), {
        subsystem: "jobs", tags: { job: "native-sdk-regression" },
      });
      await flushJobSentry();
      assert.equal(warnings.some(message => message.includes("flush failed")), false);
      assert.equal(warnings.some(message => message.includes("flush timed out")), false);
      const events = envelopes.flatMap(envelope => envelope[1])
        .filter(item => item[0].type === "event").map(item => item[1]);
      assert.equal(events.length, 1);
      assert.equal(events[0].tags.job, "native-sdk-regression");
      assert.equal(events[0].tags["native-context"], "shared");
      assert.equal(events[0].user.id, "native-sdk-user");
      assert.equal(JSON.stringify(events).includes("synthetic@example.test"), false);
      process.stdout.write("native-sdk-capture-and-flush-ok\\n");
    `;
    const driverPath = path.join(temporary, "driver.mjs");
    fs.writeFileSync(driverPath, driver);
    const output = execFileSync(process.execPath, [driverPath], {
      encoding: "utf8",
      timeout: 30_000,
      env: {
        ...process.env,
        NODE_OPTIONS: "",
        NODE_PATH: "",
        NODE_ENV: "test",
        NEXT_PHASE: "",
        NEXT_PUBLIC_SENTRY_ENVIRONMENT: "local",
        NEXT_PUBLIC_SENTRY_DSN: "https://public@example.invalid/1",
        GITHUB_ACTIONS: "",
        GITHUB_OUTPUT: "",
      },
    });
    expect(output).toContain("native-sdk-capture-and-flush-ok");
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
