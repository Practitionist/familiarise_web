/**
 * Operator views read as about the person, not to the operator: an expert's
 * Home names whose it is, a learner's empty states speak about them, the top
 * bar names the person at desktop width, and an expert's self-only settings
 * leave the hub with no "Your …" lines.
 */

import * as React from "react";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mockExpertDetails = jest.fn();
jest.mock("../../lib/dashboard-queries", () => ({
  consultantFetchers: { details: (id: string) => mockExpertDetails(id) },
}));
jest.mock("../../components/notifications/NotificationInbox", () => ({
  NotificationInbox: () => null,
}));
jest.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
}));
jest.mock("../../lib/auth-client", () => ({
  useSession: () => ({ data: null, isPending: false }),
}));
jest.mock("../../components/appointments/AppointmentCalendar", () => ({
  AppointmentCalendar: () => null,
}));
jest.mock("../../components/appointments/AppointmentSheet", () => ({
  AppointmentSheet: () => null,
}));
jest.mock("../../components/appointments/LazyAppointmentChatSheet", () => ({
  LazyAppointmentChatSheet: () => null,
}));
jest.mock("../../components/appointments/NextUpHero", () => ({
  NextUpHero: () => null,
}));

import { AppointmentsShell } from "../../components/appointments/AppointmentsShell";
import { DashboardContextBar } from "../../components/dashboard/DashboardContextBar";
import { OperatorHomeHeader } from "../../app/dashboard/consultant/[consultantId]/(features)/home/OperatorHomeHeader";
import { settingsSectionGroups } from "../../app/dashboard/consultant/[consultantId]/(features)/settings/settings";
import { personalHomeTitle } from "../../lib/dashboard/operator-view";
import type { AppointmentActionAdapter } from "../../lib/appointments/adapter";

describe("an expert's Home in operator view", () => {
  it("names the expert for an operator and falls back to a neutral line", () => {
    const expert = { userId: "u_e", name: "Lauren Anderson", image: null };
    expect(personalHomeTitle(expert, false, "expert")).toBe(
      "Lauren Anderson's home",
    );
    expect(personalHomeTitle({ ...expert, name: null }, false, "expert")).toBe(
      "This expert's home",
    );
    expect(personalHomeTitle(expert, true, "expert")).toBe(
      "Welcome back, Lauren",
    );
  });

  it("titles the page with the expert and a subtitle about them, not the operator", async () => {
    mockExpertDetails.mockResolvedValue({ user: { name: "Lauren Anderson" } });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <OperatorHomeHeader consultantId="cp_expert" />
      </QueryClientProvider>,
    );
    expect(
      await screen.findByRole("heading", { name: "Lauren Anderson's home" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("What needs them, and what's next"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/your appointments/i)).not.toBeInTheDocument();
  });
});

describe("the top bar", () => {
  const identity = { name: "Samantha Anderson" };

  it("names the person at every width in operator view", () => {
    render(<DashboardContextBar identity={identity} alwaysShowName />);
    expect(screen.getByText("Samantha Anderson").className).not.toContain(
      "md:hidden",
    );
  });

  it("keeps the name for narrow widths only otherwise, where the sidebar is gone", () => {
    render(<DashboardContextBar identity={identity} />);
    expect(screen.getByText("Samantha Anderson").className).toContain(
      "md:hidden",
    );
  });
});

describe("an expert's settings hub", () => {
  const sections = (owner: boolean) =>
    settingsSectionGroups(owner).flatMap((g) => g.sections);

  it("lists every section with its description for the owner", () => {
    expect(sections(true).every((s) => s.show && s.description)).toBe(true);
  });

  it("hides the self-only sections and the 'Your …' lines from an operator", () => {
    const shown = sections(false).filter((s) => s.show);
    expect(shown.map((s) => s.key)).not.toContain("account");
    expect(shown.map((s) => s.key)).not.toContain("notifications");
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.every((s) => s.description === "")).toBe(true);
  });
});

describe("a learner's appointments list in operator view", () => {
  const adapter = {
    role: "consultee",
    renderDialogs: () => null,
  } as unknown as AppointmentActionAdapter;
  const zone = { zone: "Asia/Kolkata" } as never;
  const shell = (operatorView: boolean) =>
    render(
      <AppointmentsShell
        vms={[]}
        adapter={adapter}
        viewerZone={zone}
        operatorView={operatorView}
      />,
    );

  it("says nothing is booked yet instead of promising the operator's sessions", () => {
    shell(true);
    expect(screen.getByText("Nothing booked yet")).toBeInTheDocument();
    expect(
      screen.queryByText("Sessions you book will show up here."),
    ).not.toBeInTheDocument();
  });

  it("keeps the learner's own wording for the owner", () => {
    shell(false);
    expect(
      screen.getByText("Sessions you book will show up here."),
    ).toBeInTheDocument();
  });
});
