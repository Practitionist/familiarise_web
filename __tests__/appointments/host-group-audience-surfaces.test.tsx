/**
 * The expert list row, side sheet, Next up card and Home never address a host's own
 * webinar or class audience as a person; a 1:1 keeps the learner's name and a
 * co-host still sees the owner's.
 */
import * as React from "react";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), refresh: jest.fn() }),
  useParams: () => ({}),
  usePathname: () => "/dashboard/consultant/cp_aarav/home",
  useSearchParams: () => new URLSearchParams(),
}));
jest.mock("../../lib/auth-client", () => ({
  useSession: () => ({ data: null }),
}));
jest.mock("../../hooks/scheduling/useLazyJoinMeeting", () => ({
  useLazyJoinMeeting: () => jest.fn(),
}));

import { AppointmentRow } from "@/components/appointments/AppointmentRow";
import { AppointmentSheet } from "@/components/appointments/AppointmentSheet";
import { NextUpHero } from "@/components/appointments/NextUpHero";
import { HomeTab } from "@/app/dashboard/consultant/[consultantId]/(features)/home/HomeTab";
import type { AppointmentActionAdapter } from "@/lib/appointments/adapter";
import { mapConsultantAppointments } from "@/lib/appointments/map-consultant";
import type { AppointmentVM } from "@/lib/appointments/view-model";
import type { TAppointment } from "@/types/appointment";

const NOW = new Date("2026-10-08T07:00:00Z");
const OWNER = "cp_aarav";
const viewerZone = { zone: "Asia/Kolkata", own: true };

const occurrence = (id: string) => ({
  id,
  startsAt: new Date("2026-10-08T08:00:00Z"),
  endsAt: new Date("2026-10-08T09:00:00Z"),
  isTentative: false,
  completionStatus: "SCHEDULED",
});

const owner = {
  id: OWNER,
  user: { name: "Aarav Anderson", image: null },
};

const webinar = {
  id: "appt_webinar",
  appointmentType: "WEBINAR",
  payment: [],
  participants: [],
  occurrences: [occurrence("occ_w")],
  webinar: {
    status: "SCHEDULED",
    webinarPlan: {
      id: "wp_1",
      title: "Expert Workshop Webinar",
      consultantProfileId: OWNER,
      consultantProfile: owner,
    },
  },
} as unknown as TAppointment;

const klass = {
  id: "appt_class",
  appointmentType: "CLASS",
  payment: [],
  participants: [],
  classId: "cls_1",
  occurrences: [occurrence("occ_c")],
  class: {
    status: "SCHEDULED",
    classPlan: {
      id: "clp_1",
      title: "System Design Cohort",
      consultantProfileId: OWNER,
      consultantProfile: owner,
    },
  },
} as unknown as TAppointment;

const consultation = {
  id: "appt_1to1",
  appointmentType: "CONSULTATION",
  payment: [],
  participants: [],
  occurrences: [occurrence("occ_1")],
  consultation: {
    status: "APPROVED",
    consultationPlan: { title: "Career chat" },
    requestedBy: { user: { name: "Priya Nair", image: null } },
  },
} as unknown as TAppointment;

const vmsFor = (consultantId: string, appointments: TAppointment[]) =>
  mapConsultantAppointments({ appointments, consultantId }, NOW);

const byKind = (vms: AppointmentVM[], kind: AppointmentVM["kind"]) => {
  const vm = vms.find((v) => v.kind === kind);
  if (!vm) throw new Error(`${kind} row missing`);
  return vm;
};

const adapter: AppointmentActionAdapter = {
  role: "consultant",
  detailHref: () => null,
  primaryAction: () => ({ kind: "view", label: "View" }),
  overflowItems: () => [],
  renderDialogs: () => null,
};

const surfaces: [string, (vm: AppointmentVM) => React.ReactElement][] = [
  [
    "list row",
    (vm) => (
      <AppointmentRow vm={vm} adapter={adapter} viewerZone={viewerZone} />
    ),
  ],
  [
    "side sheet",
    (vm) => (
      <AppointmentSheet vm={vm} adapter={adapter} onOpenChange={jest.fn()} />
    ),
  ],
  [
    "Next up card",
    (vm) => (
      <NextUpHero
        vm={vm}
        adapter={adapter}
        viewerZone={viewerZone}
        stats={[]}
      />
    ),
  ],
];

const PLACEHOLDER = /Registered attendees|Enrolled learners/;

describe.each(surfaces)("the expert %s", (_name, renderSurface) => {
  it.each(["WEBINAR", "CLASS"] as const)(
    "names no placeholder audience on the host's own %s",
    (kind) => {
      const vm = byKind(vmsFor(OWNER, [webinar, klass]), kind);
      expect(vm.counterpart.audience).toBe(true);
      render(renderSurface(vm));
      // The sheet renders in a portal, so read the whole document.
      expect(document.body.textContent).not.toMatch(PLACEHOLDER);
      expect(document.body.textContent).not.toMatch(/\bwith\b/);
      expect(screen.queryByText(/^(RA|EL)$/)).toBeNull();
    },
  );

  it("keeps the learner's name on a 1:1", () => {
    const vm = byKind(vmsFor(OWNER, [consultation]), "CONSULTATION");
    render(renderSurface(vm));
    expect(document.body.textContent).toContain("Priya Nair");
  });

  it("shows a co-host the owner's name", () => {
    const vm = byKind(vmsFor("cp_guest", [webinar]), "WEBINAR");
    expect(vm.counterpart.audience).toBeUndefined();
    render(renderSurface(vm));
    expect(document.body.textContent).toContain("Aarav Anderson");
  });
});

describe("the expert Home (Today and Upcoming Sessions)", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
  });
  afterEach(() => jest.useRealTimers());

  const renderHome = (consultantId: string, appointments: TAppointment[]) =>
    render(
      <QueryClientProvider client={new QueryClient()}>
        <HomeTab
          appointments={appointments}
          consultantId={consultantId}
          payoutSetup={undefined}
          viewerZone={viewerZone}
        />
      </QueryClientProvider>,
    );

  it("titles the host's own webinar and class by their plan, with no placeholder audience", () => {
    renderHome(OWNER, [webinar, klass]);
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(PLACEHOLDER);
    expect(text).toContain("Expert Workshop Webinar");
    expect(text).toContain("System Design Cohort");
    expect(screen.queryByText(/^(RA|EL|AA)$/)).toBeNull();
  });

  it("keeps the learner's name on a 1:1", () => {
    renderHome(OWNER, [consultation]);
    expect(screen.getAllByText("Priya Nair").length).toBeGreaterThan(0);
  });

  it("shows a co-host the owner's name", () => {
    renderHome("cp_guest", [webinar]);
    expect(screen.getAllByText("Aarav Anderson").length).toBeGreaterThan(0);
  });
});
