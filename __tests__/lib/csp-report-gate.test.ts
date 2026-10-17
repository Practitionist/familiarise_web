/**
 * CSP reports bypass every Sentry SDK hook and each one is a billable error
 * event, so a report-only policy must not carry a report directive. Reads
 * `next.config.mjs` as source for the reason given in remove-console-config.test.ts.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

const src = readFileSync(path.join(process.cwd(), "next.config.mjs"), "utf8");

describe("CSP report directives", () => {
  it("are built only when the policy is enforced", () => {
    expect(src).toMatch(
      /const CSP_REPORT_URL = CSP_ENFORCE \? sentryCspReportUrl\(\) : undefined;/,
    );
  });

  it("declare CSP_ENFORCE before CSP_REPORT_URL reads it", () => {
    expect(src.indexOf("const CSP_ENFORCE =")).toBeGreaterThan(-1);
    expect(src.indexOf("const CSP_ENFORCE =")).toBeLessThan(
      src.indexOf("const CSP_REPORT_URL ="),
    );
  });
});
