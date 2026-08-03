/**
 * Org appointment detail reuses the consultee adapter but its URL has orgId,
 * not consulteeId. Without an override the Reschedule overflow never appears.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();

describe("org appointment detail Reschedule affordance", () => {
  it("passes consulteeId override into the shared adapter", () => {
    const src = readFileSync(
      path.join(
        root,
        "app/dashboard/organization/[orgId]/appointments/[appointmentId]/DetailPageClient.tsx",
      ),
      "utf8",
    );
    expect(src).toContain("useConsulteeAppointmentsAdapter({");
    expect(src).toContain("consulteeProfileId");
    // Stay under org for detail navigation; reschedule still deep-links out.
    expect(src).toContain("detailHref");
    expect(src).toContain("/dashboard/organization/${orgId}/appointments/");
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
    expect(src).toContain(
      "`/dashboard/consultee/${consulteeId}/appointments/${vm.appointmentId}/reschedule`",
    );
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
