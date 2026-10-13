/**
 * @jest-environment node
 */

/**
 * Every production call that mints a Razorpay order is listed here. A new
 * money flow must be added on purpose, so it is reviewed against the one price
 * derivation, the INR guard and the capture pipeline before it ships.
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../..");
const SOURCE_DIRS = [
  "app",
  "lib",
  "actions",
  "scripts",
  "jobs",
  "utils",
  "netlify",
  "components",
];
const MINT_CALL =
  /\b(?:createRazorpayOrder|createPaymentIntent)\(|\.orders\.create\(/;

const KNOWN_MINT_SITES = [
  "app/api/organizations/[orgId]/billing-account/invoices/[invoiceId]/pay/route.ts",
  "app/api/organizations/[orgId]/billing-account/wallet/top-ups/route.ts",
  "app/api/overage/[overageEventId]/order/route.ts",
  "app/api/recordings/[recordingId]/purchase/route.ts",
  "lib/payments/core/razorpay.ts",
  "lib/payments/index.ts",
  "lib/payments/operations/approval-payment.ts",
  "lib/payments/operations/checkout.ts",
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "node_modules" || entry.name === "__tests__"
        ? []
        : sourceFiles(full);
    }
    return /\.(ts|tsx|mts)$/.test(entry.name) ? [full] : [];
  });
}

describe("Razorpay order mint call sites", () => {
  it("matches the reviewed list exactly", () => {
    const found = SOURCE_DIRS.flatMap((dir) =>
      sourceFiles(path.join(ROOT, dir)),
    )
      .filter((file) =>
        readFileSync(file, "utf8")
          .split("\n")
          .some((line) => MINT_CALL.test(line) && !/^\s*(\*|\/\/)/.test(line)),
      )
      .map((file) => path.relative(ROOT, file).split(path.sep).join("/"))
      .sort();

    expect(found).toEqual([...KNOWN_MINT_SITES].sort());
  });
});
