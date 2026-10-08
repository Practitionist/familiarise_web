import { mapConsultantAppointments } from "@/lib/appointments/map-consultant";
import { mapAppointmentDetail } from "@/lib/appointments/map-detail";
import type { TAppointmentDetail } from "@/lib/data/appointment-detail";
import type { TAppointment } from "@/types/appointment";

const NOW = new Date("2026-10-08T07:00:00Z");

describe("Consultant group-event counterpart resolution", () => {
  it("resolves host WEBINAR and CLASS counterparts to Registered attendees / Enrolled learners instead of host's own name", () => {
    const webinarAppointment = {
      id: "appt_webinar_1",
      appointmentType: "WEBINAR",
      occurrences: [
        {
          id: "occ_webinar_1",
          startsAt: new Date("2026-10-08T08:00:00Z"),
          endsAt: new Date("2026-10-08T09:00:00Z"),
          isTentative: false,
          completionStatus: "SCHEDULED",
        },
      ],
      webinar: {
        status: "IN_PROGRESS",
        webinarPlan: {
          id: "wp_1",
          title: "Expert Workshop Webinar",
          consultantProfileId: "cp_aarav",
          consultantProfile: {
            id: "cp_aarav",
            user: { name: "Aarav Anderson", image: null },
          },
        },
      },
    } as unknown as TAppointment;

    const classAppointment = {
      id: "appt_class_1",
      appointmentType: "CLASS",
      classId: "cls_1",
      occurrences: [
        {
          id: "occ_class_1",
          startsAt: new Date("2026-10-08T10:00:00Z"),
          endsAt: new Date("2026-10-08T11:00:00Z"),
          isTentative: false,
          completionStatus: "SCHEDULED",
        },
      ],
      class: {
        status: "IN_PROGRESS",
        classPlan: {
          id: "clp_1",
          title: "System Design Cohort",
          consultantProfileId: "cp_aarav",
          consultantProfile: {
            id: "cp_aarav",
            user: { name: "Aarav Anderson", image: null },
          },
        },
      },
    } as unknown as TAppointment;

    const vms = mapConsultantAppointments(
      {
        appointments: [webinarAppointment, classAppointment],
        consultantId: "cp_aarav",
      },
      NOW,
    );

    const webinarVm = vms.find((v) => v.kind === "WEBINAR");
    const classVm = vms.find((v) => v.kind === "CLASS");
    expect(webinarVm?.counterpart.name).toBe("Registered attendees");
    expect(classVm?.counterpart.name).toBe("Enrolled learners");

    const detailPayload = {
      appointment: webinarAppointment,
    } as unknown as TAppointmentDetail;

    const consultantDetail = mapAppointmentDetail(
      detailPayload,
      "consultant",
      NOW,
    );
    const consulteeDetail = mapAppointmentDetail(
      detailPayload,
      "consultee",
      NOW,
    );

    expect(consultantDetail.vm.counterpart.name).toBe("Registered attendees");
    expect(consulteeDetail.vm.counterpart.name).toBe("Aarav Anderson");
  });

  it("preserves plan owner name as counterpart when viewing as a collaborator", () => {
    const collabWebinar = {
      id: "appt_webinar_collab",
      appointmentType: "WEBINAR",
      occurrences: [
        {
          id: "occ_webinar_collab",
          startsAt: new Date("2026-10-08T08:00:00Z"),
          endsAt: new Date("2026-10-08T09:00:00Z"),
          isTentative: false,
          completionStatus: "SCHEDULED",
        },
      ],
      webinar: {
        status: "IN_PROGRESS",
        webinarPlan: {
          id: "wp_collab",
          title: "Co-hosted Workshop",
          consultantProfileId: "cp_owner",
          consultantProfile: {
            id: "cp_owner",
            user: { name: "Aarav Anderson", image: null },
          },
          collaborators: [
            { consultantProfileId: "cp_guest_speaker", role: "CO_HOST" },
          ],
        },
      },
    } as unknown as TAppointment;

    const vms = mapConsultantAppointments(
      {
        appointments: [collabWebinar],
        consultantId: "cp_guest_speaker",
      },
      NOW,
    );

    expect(vms[0]?.counterpart.name).toBe("Aarav Anderson");

    const collabDetailPayload = {
      appointment: collabWebinar,
    } as unknown as TAppointmentDetail;

    const collaboratorDetail = mapAppointmentDetail(
      collabDetailPayload,
      "consultant",
      NOW,
      "cp_guest_speaker",
    );
    const ownerDetail = mapAppointmentDetail(
      collabDetailPayload,
      "consultant",
      NOW,
      "cp_owner",
    );

    expect(collaboratorDetail.vm.counterpart.name).toBe("Aarav Anderson");
    expect(collaboratorDetail.vm.counterpart.roleLabel).toBe("Host");
    expect(ownerDetail.vm.counterpart.name).toBe("Registered attendees");
  });
});
