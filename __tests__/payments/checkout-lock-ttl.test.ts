/**
 * @jest-environment node
 */

/**
 * #832 follow-up — bugs/finances/high-concurrency-and-spikes.md documents the
 * serverless-freeze worst case for CLASS: the platform can suspend the lock
 * holder AFTER the single checked renewal while Redis keeps counting the TTL
 * down, so the old 300s CLASS budget could expire mid-checkout and admit a
 * second instance. Source-contract pins (same idiom as
 * idempotency-minting.test.ts) freeze the values until someone deliberately
 * re-litigates them.
 */

import fs from "fs";
import path from "path";

const read = (rel: string) =>
  fs.readFileSync(path.join(process.cwd(), rel), "utf8");

describe("CHECKOUT_LOCK_TTL_MS (#832 serverless-freeze worst case)", () => {
  const src = read("utils/appointmentlock.ts");

  it("raises CLASS to the documented freeze worst case: 600s", () => {
    expect(src).toMatch(/CLASS:\s*600_000,/);
  });

  it("no longer carries the insufficient 300s CLASS budget", () => {
    expect(src).not.toMatch(/CLASS:\s*300_000/);
  });

  it("keeps the smaller shapes on their sized #832 budgets", () => {
    expect(src).toMatch(/CONSULTATION:\s*60_000,/);
    expect(src).toMatch(/SUBSCRIPTION:\s*120_000,/);
    expect(src).toMatch(/WEBINAR:\s*120_000,/);
  });
});
