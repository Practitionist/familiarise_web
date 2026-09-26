/**
 * The org appointment detail page takes BOTH ids from the URL, and neither
 * constrains the other: `/dashboard/organization/<orgId>/appointments/<apptId>`
 * would happily pair a member's own org with somebody else's appointment.
 *
 * Membership alone is not enough to close that. `requireOrgAccess` answers "is
 * the caller in this org", which says nothing about whether the appointment
 * belongs to the org or whether the caller is on it. Both have to be asked
 * separately, and this file pins that they are — it is the same shape as the
 * SSR ownership hole closed in #1029, where a server page trusted a route param
 * because a client layout appeared to have checked it.
 *
 * #1527 widened WHO gets a view, never what a non-participant sees: the
 * attendee gets the full detail, the delivering expert the consultant detail,
 * and operators only ADR 20 metadata (payer admins may also cancel or ask to
 * reschedule, Q11). Anyone else still gets a 404.
 */

import { readFileSync } from "fs";
import { join } from "path";

const PAGE =
  "app/dashboard/organization/[orgId]/appointments/[appointmentId]/page.tsx";

const src = readFileSync(join(process.cwd(), PAGE), "utf8");

describe("org appointment detail binds both ids", () => {
  it("requires org membership first", () => {
    expect(src).toContain("await requireOrgAccess(orgId)");
  });

  it("checks the appointment belongs to THIS org, not merely to some org", () => {
    // Without this, any member of any org could read any org-funded
    // appointment by pairing their own orgId with a foreign appointmentId.
    expect(src).toContain("appointment.organizationId !== orgId");
  });

  it("checks the caller is a party to the appointment", () => {
    // Requester, trial consultee, or a live seat holder (#1554) — the same
    // test the consultee detail page applies.
    expect(src).toContain("requestedBy?.id === profile.id");
    expect(src).toContain("trial?.consulteeProfile?.id === profile.id");
    expect(src).toContain("participants.some");
  });

  it("fails closed on every branch", () => {
    // notFound() rather than a redirect: a redirect would confirm the
    // appointment exists to someone who should not know that.
    const checks = [
      "if (access.error)",
      "if (!detail) notFound()",
      "if (appointment.organizationId !== orgId) notFound()",
      'if (!actsForOrg && !hasOrgPermission(role, "operations.read")) notFound()',
    ];
    for (const c of checks) expect(src).toContain(c);
  });

  it("gives the delivering expert the consultant detail, not a 404", () => {
    expect(src).toContain(
      "appointmentViewerSides(userId, detail).asConsultant",
    );
    expect(src).toContain("<DelivererDetailClient");
  });

  it("offers org-actor actions only to payer admins, only on 1:1 bookings", () => {
    expect(src).toContain("const actsForOrg = isPayerAdminRole(role)");
    expect(src).toContain(
      "appointment.consultation ?? appointment.subscription",
    );
    expect(src).toMatch(/canCancel=\{\s*actsForOrg && status !== null/);
  });

  it("orders the org check before the participation check", () => {
    // Cheap scalar comparison before the ownership walk; also means a
    // cross-org id never reaches the participation logic at all.
    const orgCheck = src.indexOf("appointment.organizationId !== orgId");
    const ownsCheck = src.indexOf("const owns =");
    expect(orgCheck).toBeGreaterThan(-1);
    expect(ownsCheck).toBeGreaterThan(orgCheck);
  });

  it("is a server component, so the checks run before anything streams", () => {
    expect(src.slice(0, 200)).not.toContain('"use client"');
  });
});
