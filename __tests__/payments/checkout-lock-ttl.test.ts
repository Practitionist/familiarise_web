/**
 * @jest-environment node
 */

/**
 * #832 follow-up — bugs/finances/high-concurrency-and-spikes.md documents the
 * serverless-freeze worst case for COHORT: the platform can suspend the lock
 * holder AFTER the single checked renewal while Redis keeps counting the TTL
 * down, so the old 300s COHORT budget could expire mid-checkout and admit a
 * second instance.
 *
 * Asserts the IMPORTED constant (CodeRabbit #1220 triage): source-text regexes
 * break on formatter changes (600_000 ↔ 600000) and pass through duplicate-key
 * overrides — neither can lie here.
 */

import { CHECKOUT_LOCK_TTL_MS } from "../../utils/appointmentlock";

describe("CHECKOUT_LOCK_TTL_MS (#832 serverless-freeze worst case)", () => {
  it("raises COHORT to the documented freeze worst case: 600s", () => {
    expect(CHECKOUT_LOCK_TTL_MS.COHORT).toBe(600_000);
  });

  it("no longer carries the insufficient 300s COHORT budget", () => {
    expect(CHECKOUT_LOCK_TTL_MS.COHORT).not.toBe(300_000);
  });

  it("keeps the smaller shapes on their sized #832 budgets", () => {
    expect(CHECKOUT_LOCK_TTL_MS.CONSULTATION).toBe(60_000);
    expect(CHECKOUT_LOCK_TTL_MS.SUBSCRIPTION).toBe(120_000);
    expect(CHECKOUT_LOCK_TTL_MS.WEBINAR).toBe(120_000);
  });
});
