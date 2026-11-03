/**
 * One B2C recording notice goes to the host and the attendees with a single
 * href; the go resolver must send each recipient to their own side of the
 * booking, never a host to the buyer Library.
 */

import { resolveGoHref, type GoViewer } from "@/lib/dashboard/go";
import { appointmentRecordingsHref } from "@/lib/novu/resolve-href";

const APPOINTMENT = "appt-1";

/** The go page's facet and path segments for an absolute notice href. */
function goTarget(href: string): { facet: string; path: string[] } {
  const [, , , facet, ...path] = new URL(href).pathname.split("/");
  return { facet, path };
}

function landing(
  viewer: GoViewer,
  sides: { asConsultant: boolean; asConsultee: boolean },
): string {
  const { facet, path } = goTarget(
    appointmentRecordingsHref(null, APPOINTMENT),
  );
  return resolveGoHref(facet, path, viewer, {
    ...sides,
    organizationId: null,
  });
}

const HOST = { asConsultant: true, asConsultee: false };
const ATTENDEE = { asConsultant: false, asConsultee: true };

describe("B2C recording notice deep link", () => {
  it("names the booking, not the Library", () => {
    const href = appointmentRecordingsHref(null, APPOINTMENT);
    expect(href).toMatch(
      /\/dashboard\/go\/auto\/appointments\/appt-1\/recordings$/,
    );
    expect(href).not.toContain("library");
  });

  it("sends an expert-only host to their hosted recordings", () => {
    expect(
      landing({ role: "CONSULTANT", consultantProfileId: "cp-1" }, HOST),
    ).toBe(`/dashboard/consultant/cp-1/appointments/${APPOINTMENT}/recordings`);
  });

  it("sends a dual-profile host to the expert side, not their learner Library", () => {
    expect(
      landing(
        {
          role: "CONSULTANT",
          consultantProfileId: "cp-1",
          consulteeProfileId: "ce-1",
        },
        HOST,
      ),
    ).toBe(`/dashboard/consultant/cp-1/appointments/${APPOINTMENT}/recordings`);
  });

  it("sends an attendee to their learner side", () => {
    expect(
      landing({ role: "CONSULTEE", consulteeProfileId: "ce-2" }, ATTENDEE),
    ).toBe(`/dashboard/consultee/ce-2/appointments/${APPOINTMENT}/recordings`);
  });

  it("sends a dual-profile attendee to the learner side", () => {
    expect(
      landing(
        {
          role: "CONSULTANT",
          consultantProfileId: "cp-3",
          consulteeProfileId: "ce-3",
        },
        ATTENDEE,
      ),
    ).toBe(`/dashboard/consultee/ce-3/appointments/${APPOINTMENT}/recordings`);
  });

  it("keeps an org-hosted notice on the org Library", () => {
    expect(appointmentRecordingsHref("org-1", APPOINTMENT)).toMatch(
      /\/dashboard\/organization\/org-1\/library\?tab=recordings$/,
    );
  });
});
