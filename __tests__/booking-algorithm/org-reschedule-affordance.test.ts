/**
 * Org appointment detail reuses the consultee adapter but its URL has orgId,
 * not consulteeId. Without an override the Reschedule overflow never appears.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();

describe("org appointment detail Reschedule affordance", () => {
  it("passes SSR consulteeId into the shared adapter", () => {
    const client = readFileSync(
      path.join(
        root,
        "app/dashboard/organization/[orgId]/appointments/[appointmentId]/DetailPageClient.tsx",
      ),
      "utf8",
    );
    const page = readFileSync(
      path.join(
        root,
        "app/dashboard/organization/[orgId]/appointments/[appointmentId]/page.tsx",
      ),
      "utf8",
    );
    expect(client).toContain("useConsulteeAppointmentsAdapter({");
    expect(client).toContain("consulteeId,");
    expect(page).toContain("consulteeId={profile.id}");
    // Stay under org for detail navigation; reschedule still deep-links out,
    // but carries a returnTo back to this page (#1166).
    expect(client).toContain("detailHref");
    expect(client).toContain("/dashboard/organization/${orgId}/appointments/");
    expect(client).toContain("rescheduleReturnTo:");
  });

  it("adapter accepts an optional consulteeId and falls back to params/session", () => {
    const src = readFileSync(
      path.join(
        root,
        "components/appointments/consultee/ConsulteeAppointmentsAdapter.tsx",
      ),
      "utf8",
    );
    expect(src).toContain("options?.consulteeId");
    expect(src).toContain("session?.user?.consulteeProfileId");
    // #1166 — the reschedule URL gained an optional returnTo, so the template
    // no longer ends at /reschedule; pin the path and the threading instead.
    expect(src).toContain(
      "/dashboard/consultee/${consulteeId}/appointments/${vm.appointmentId}/reschedule",
    );
    expect(src).toContain("options?.rescheduleReturnTo");
    expect(src).toContain("encodeURIComponent(options.rescheduleReturnTo)");
  });
});

describe("consultant reschedule legend wiring", () => {
  it("SlotPicker sets showConsultantLegend for consultant propose, not consultee", () => {
    const src = readFileSync(
      path.join(root, "components/scheduling/SlotPicker.tsx"),
      "utf8",
    );
    expect(src).toContain('policy.kind === "RESCHEDULE_CONSULTANT"');
    expect(src).toContain("showConsultantLegend");
    // Must not key the consultant legend solely on eventId (consultee also has it).
    expect(src).not.toMatch(
      /showConsultantLegend=\{\s*Boolean\(subject\.eventId\)\s*\}/,
    );
  });

  it("SafeUnifiedCalendar honours showConsultantLegend over mode alone", () => {
    const src = readFileSync(
      path.join(root, "components/scheduling/SafeUnifiedCalendar.tsx"),
      "utf8",
    );
    expect(src).toContain("showConsultantLegend");
    expect(src).toContain("CONSULTANT_LEGEND_KEYS");
  });
});
