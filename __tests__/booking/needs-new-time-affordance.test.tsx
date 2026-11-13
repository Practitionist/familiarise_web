/**
 * A booking with no session left offers no Reschedule: the expert places the
 * new time (allocation grid on an approved request) and anyone else is sent
 * to support. Reschedule shows only while a confirmed session is 24h+ out.
 */
import * as React from "react";
import { render, renderHook, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mockPush = jest.fn();
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush, refresh: jest.fn() }),
  useParams: () => ({ consulteeId: "ce-learner" }),
}));
let mockSession: Record<string, unknown> | null = null;
jest.mock("../../lib/auth-client", () => ({
  useSession: () => ({ data: mockSession ? { user: mockSession } : null }),
}));
jest.mock("../../hooks/scheduling/useLazyJoinMeeting", () => ({
  useLazyJoinMeeting: () => jest.fn(),
}));
jest.mock("../../hooks/use-toast", () => ({
  useToast: () => ({ toast: jest.fn() }),
}));
jest.mock("../../components/appointments/consultee/useEventActions", () => ({
  useEventActions: () => ({ handleCancelConfirm: jest.fn(), isLoading: false }),
}));
jest.mock(
  "../../app/dashboard/consultant/[consultantId]/(features)/appointments/components/useConsultantEventActions",
  () => ({
    useConsultantEventActions: () => ({
      handleCancelConfirm: jest.fn(),
      handleRetime: jest.fn(),
      isLoading: false,
    }),
  }),
);
jest.mock(
  "../../components/appointments/consultee/CancelConfirmationDialog",
  () => ({ CancelConfirmationDialog: () => null }),
);
jest.mock("../../components/appointments/RetimeDialog", () => ({
  RetimeDialog: () => null,
}));

import type {
  AppointmentVM,
  OccurrenceLike,
} from "../../lib/appointments/view-model";
import { useConsulteeAppointmentsAdapter } from "../../components/appointments/consultee/ConsulteeAppointmentsAdapter";
import { useConsultantAppointmentsAdapter } from "../../app/dashboard/consultant/[consultantId]/(features)/appointments/ConsultantAppointmentsAdapter";
import { AppointmentSheet } from "../../components/appointments/AppointmentSheet";
import { newTimeDoor } from "../../lib/appointments/new-time-door";
import { rescheduleReleasable } from "../../lib/booking/reschedule-proposals";

const APPT = "8b2f6c1e-1d2a-4f3b-9c4d-5e6f7a8b9c0d";
const HOUR = 3_600_000;

function row(
  hoursOut: number,
  completionStatus: string,
  isTentative = false,
): OccurrenceLike {
  const startsAt = new Date(Date.now() + hoursOut * HOUR);
  return {
    id: `occ-${hoursOut}-${completionStatus}`,
    appointmentId: APPT,
    startsAt,
    endsAt: new Date(startsAt.getTime() + HOUR),
    isTentative,
    completionStatus,
  };
}

function vm(
  rows: OccurrenceLike[],
  overrides: Partial<AppointmentVM> = {},
): AppointmentVM {
  return {
    id: APPT,
    appointmentId: APPT,
    kind: "CONSULTATION",
    title: "Career chat",
    counterpart: { name: "Priya", image: null },
    consultantProfileId: "ca-expert",
    status: "APPROVED",
    bucket: "upcoming",
    needsActionReason: null,
    nextAt: null,
    occurrences: [],
    group: null,
    meta: null,
    organizationId: null,
    pendingPaymentUrl: null,
    collaborators: [],
    collaboratorRole: null,
    raw: {
      rawOccurrences: rows,
      source: {
        requestedBy: { user: { id: "u-learner" } },
        consultationPlan: { consultantProfile: { user: { id: "u-expert" } } },
      },
    },
    ...overrides,
  };
}

function wrapper({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <QueryClientProvider client={new QueryClient()}>
      {children}
    </QueryClientProvider>
  );
}

const keys = (items: { key: string }[]) => items.map((item) => item.key);
const consulteeAdapter = () =>
  renderHook(() => useConsulteeAppointmentsAdapter(), { wrapper }).result
    .current;
const consultantAdapter = () =>
  renderHook(() => useConsultantAppointmentsAdapter("ca-expert"), { wrapper })
    .result.current;

beforeEach(() => {
  jest.clearAllMocks();
  window.matchMedia = jest.fn().mockReturnValue({
    matches: true,
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
  });
});

describe("rescheduleReleasable", () => {
  const now = new Date();
  it("needs a confirmed SCHEDULED session at least 24 hours out", () => {
    expect(rescheduleReleasable([row(48, "SCHEDULED")], now)).toBe(true);
    expect(rescheduleReleasable([row(5, "SCHEDULED")], now)).toBe(false);
    expect(rescheduleReleasable([row(48, "SCHEDULED", true)], now)).toBe(false);
    expect(rescheduleReleasable([row(48, "RESCHEDULED", true)], now)).toBe(
      false,
    );
    expect(rescheduleReleasable([row(48, "CANCELLED")], now)).toBe(false);
    expect(rescheduleReleasable([], now)).toBe(false);
  });
});

describe("newTimeDoor", () => {
  it("opens the allocation grid for an approved request", () => {
    expect(
      newTimeDoor({
        consultantId: "ca-expert",
        status: "APPROVED",
        consultationId: "cr-1",
      }),
    ).toEqual({
      label: "Place a new time",
      href: "/dashboard/consultant/ca-expert/requests/cr-1/allocate?type=consultation",
    });
    expect(
      newTimeDoor({
        consultantId: "ca-expert",
        status: "APPROVED",
        subscriptionId: "sub-1",
      }).href,
    ).toBe(
      "/dashboard/consultant/ca-expert/requests/sub-1/allocate?type=subscription",
    );
  });

  it("sends a booking that is not allocatable to support", () => {
    expect(
      newTimeDoor({
        consultantId: "ca-expert",
        status: "SCHEDULED",
        consultationId: "cr-1",
      }),
    ).toEqual({ label: "Contact support", href: "/support" });
  });
});

describe("consultee overflow", () => {
  beforeEach(() => {
    mockSession = {
      id: "u-learner",
      role: "USER",
      consulteeProfileId: "ce-learner",
    };
  });

  it("offers Reschedule for a confirmed session 24h+ out", () => {
    const items = consulteeAdapter().overflowItems(vm([row(72, "SCHEDULED")]));
    expect(items.find((i) => i.key === "reschedule")?.label).toBe("Reschedule");
  });

  it("offers Reschedule inside 24 hours: a 1:1 move there is agreed, not refused", () => {
    expect(
      keys(consulteeAdapter().overflowItems(vm([row(5, "SCHEDULED")]))),
    ).toContain("reschedule");
  });

  it("offers no Reschedule on a booking whose sessions were all cancelled", () => {
    const items = consulteeAdapter().overflowItems(
      vm([row(72, "CANCELLED")], { needsActionReason: "NEEDS_RESCHEDULING" }),
    );
    expect(keys(items)).not.toContain("reschedule");
    expect(keys(items)).not.toContain("new-time");
  });
});

describe("consultant overflow", () => {
  beforeEach(() => {
    mockSession = {
      id: "u-expert",
      role: "USER",
      consultantProfileId: "ca-expert",
    };
  });

  it("routes a parked booking on a scheduled parent to support, not Reschedule", () => {
    const items = consultantAdapter().overflowItems(
      vm([row(72, "RESCHEDULED", true)], {
        status: "SCHEDULED",
        needsActionReason: "NEEDS_RESCHEDULING",
      }),
    );
    expect(keys(items)).not.toContain("reschedule");
    const next = items.find((i) => i.key === "new-time");
    expect(next).toMatchObject({ label: "Contact support", href: "/support" });
  });

  it("offers no Reschedule once every session is cancelled", () => {
    const items = consultantAdapter().overflowItems(
      vm([row(72, "CANCELLED")], { needsActionReason: "NEEDS_RESCHEDULING" }),
    );
    expect(keys(items)).not.toContain("reschedule");
  });
});

describe("sheet note for a booking with no session left", () => {
  const sheet = (role: "consultee" | "consultant", status = "APPROVED") =>
    render(
      <AppointmentSheet
        vm={vm([], { status, needsActionReason: "NEEDS_RESCHEDULING" })}
        onOpenChange={jest.fn()}
        adapter={{
          role,
          detailHref: () => null,
          primaryAction: () => ({ kind: "view", label: "View" }),
          overflowItems: () => [],
          renderDialogs: () => null,
        }}
      />,
    );

  it("tells the consultee the expert places the new time, with support", () => {
    sheet("consultee");
    expect(screen.getByText(/Priya will place a new time\./)).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: "Contact support" })
        .getAttribute("href"),
    ).toBe("/support");
    expect(screen.queryByText(/Propose new times/)).toBeNull();
  });

  it("points an expert with no allocatable request to support", () => {
    sheet("consultant", "SCHEDULED");
    expect(
      screen
        .getByRole("link", { name: "Contact support" })
        .getAttribute("href"),
    ).toBe("/support");
  });
});
