/**
 * @jest-environment node
 */

/**
 * A webinar or class is ONE Appointment shared by every registrant, and
 * checkout tags it with the HOST's org (`plan.organizationId`) rather than the
 * first registrant's — deliberately, so whoever books first does not decide
 * which organization the event belongs to. Per-registrant funding lives on
 * `Payment.organizationId` instead.
 *
 * The consequence nobody had traced: the org appointments view filtered on
 * `Appointment.organizationId` alone, so a sponsor that paid to put five
 * employees into someone else's public webinar saw NOTHING. The money appeared
 * on its invoice and the seats came off its program, but the session itself was
 * invisible. 1:1 kinds were never affected — there the appointment's org is
 * already the funding org.
 *
 * Widening that view to hosted-OR-funded is only safe if it stays narrow in the
 * other direction. A shared appointment may carry registrants from several
 * sponsors and the public, so a sponsor must see the seats it paid for and not
 * the ones it did not. That is the boundary this file pins.
 */

import { readFileSync } from "fs";
import { join } from "path";

import { buildWhere } from "@/lib/api/scope/list-appointments";

const SRC = readFileSync(
  join(process.cwd(), "lib/api/scope/list-appointments.ts"),
  "utf8",
);

describe("a sponsor sees events it funded, not only ones it hosts", () => {
  it("matches on host org OR funding payment", () => {
    const w = buildWhere({
      scope: { kind: "org", orgId: "acme" },
      userId: "irrelevant",
    }) as Record<string, unknown>;

    const or = w.OR as Record<string, unknown>[];
    expect(or).toContainEqual({ organizationId: "acme" });
    expect(or).toContainEqual({ payment: { some: { organizationId: "acme" } } });
  });

  it("does not pin organizationId at the top level any more", () => {
    // A top-level `organizationId` would AND with the OR and re-exclude every
    // funded-but-not-hosted event — silently restoring the bug.
    const w = buildWhere({
      scope: { kind: "org", orgId: "acme" },
      userId: "irrelevant",
    }) as Record<string, unknown>;
    expect(w.organizationId).toBeUndefined();
  });
});

describe("but only the sponsor's OWN seats are returned", () => {
  it("the payer include is filtered to the viewing org", () => {
    // An unfiltered `payment: true` would hand a sponsor every registrant's
    // identity on a shared webinar — including other sponsors' employees and
    // members of the public. The `where` is the whole guard.
    expect(SRC).toContain("where: { organizationId: params.scope.orgId }");

    const start = SRC.indexOf("payment: {\n                where:");
    expect(start).toBeGreaterThan(-1);
  });

  it("the payer include is attached ONLY on the org scope", () => {
    // `orgMember` is already narrowed to the viewer's own rows and `personal`
    // has no org at all; attaching it there would be meaningless at best.
    expect(SRC).toContain('...(params.scope.kind === "org"');
  });

  it("selects the payer's identity and nothing else from Payment", () => {
    const start = SRC.indexOf("payment: {\n                where:");
    const block = SRC.slice(start, start + 400);

    expect(block).toContain("user: { select: { id: true, name: true, email: true } }");
    // No money on this surface: amounts belong on Billing and Reimbursements,
    // both of which gate on finance permissions rather than operations.read.
    for (const field of ["amount", "amountPaise", "paymentIntent", "status"]) {
      expect(block).not.toContain(`${field}: true`);
    }
  });

  it("still applies no user filter — the org arm is role-gated, not self-scoped", () => {
    const w = buildWhere({
      scope: { kind: "org", orgId: "acme" },
      userId: "u1",
    });
    expect(JSON.stringify(w)).not.toContain("u1");
  });
});
