import * as React from "react";
import { render, renderHook, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// The reschedule page memoizes its reads with React.cache, a server-only export.
jest.mock("react", () => ({
  ...jest.requireActual("react"),
  cache: <T,>(fn: T) => fn,
}));

const mockPush = jest.fn();
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush, refresh: jest.fn() }),
  useParams: () => ({ consulteeId: "ce-learner" }),
  notFound: () => {
    throw new Error("notFound");
  },
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
jest.mock(
  "../../app/dashboard/organization/[orgId]/appointments/AllocateOrgBookingDialog",
  () => ({ AllocateOrgBookingDialog: () => null }),
);

const mockAccess = jest.fn();
const mockOwns = jest.fn();
jest.mock("../../lib/auth/personal-dashboard-access", () => ({
  requirePersonalProfileAccess: (...a: unknown[]) => mockAccess(...a),
  viewerOwnsPersonalProfile: (...a: unknown[]) => mockOwns(...a),
}));
const mockGetSession = jest.fn();
jest.mock("../../lib/auth-server", () => ({
  getSession: () => mockGetSession(),
}));
const mockReadDetail = jest.fn();
jest.mock("../../lib/data/appointment-detail", () => ({
  ...jest.requireActual("../../lib/data/appointment-detail"),
  readAppointmentDetail: (...a: unknown[]) => mockReadDetail(...a),
}));
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    consulteeProfile: {
      findUnique: async () => ({ userId: "u-learner" }),
    },
  },
}));
jest.mock("../../lib/scheduling/time-picker-subject", () => ({
  buildRescheduleSubject: () => ({
    title: "Career chat",
    typeLabel: "Consultation",
    subject: {},
    consultantName: "Expert",
  }),
}));
jest.mock(
  "../../app/dashboard/consultee/[consulteeId]/(features)/appointments/[appointmentId]/reschedule/RescheduleClient",
  () => ({ RescheduleClient: () => <p>time picker</p> }),
);

import type { AppointmentVM } from "../../lib/appointments/view-model";
import { OPS_HINT_LABEL } from "../../components/appointments/OperatorOpsHint";
import { useConsulteeAppointmentsAdapter } from "../../components/appointments/consultee/ConsulteeAppointmentsAdapter";
import { useConsultantAppointmentsAdapter } from "../../app/dashboard/consultant/[consultantId]/(features)/appointments/ConsultantAppointmentsAdapter";
import {
  OrgActorDetail,
  type OrgActorDetailProps,
} from "../../app/dashboard/organization/[orgId]/appointments/[appointmentId]/OrgActorDetail";
import ConsulteeReschedulePage, {
  generateMetadata as consulteeRescheduleMetadata,
} from "../../app/dashboard/consultee/[consulteeId]/(features)/appointments/[appointmentId]/reschedule/page";

const APPT = "8b2f6c1e-1d2a-4f3b-9c4d-5e6f7a8b9c0d";
const OPS = `/dashboard/staff/appointments?open=${APPT}`;
const ADMIN_OPS = `/dashboard/admin/appointments?open=${APPT}`;

/** An approved consultation between u-learner and u-expert with one confirmed future session. */
function vm(): AppointmentVM {
  const startsAt = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
  return {
    id: APPT,
    appointmentId: APPT,
    kind: "CONSULTATION",
    title: "Career chat",
    counterpart: { name: "Expert", image: null },
    consultantProfileId: "ca-expert",
    status: "APPROVED",
    bucket: "upcoming",
    needsActionReason: null,
    nextAt: startsAt,
    occurrences: [],
    group: null,
    meta: null,
    organizationId: null,
    pendingPaymentUrl: null,
    collaborators: [],
    collaboratorRole: null,
    raw: {
      rawOccurrences: [
        {
          id: "occ-1",
          appointmentId: APPT,
          startsAt,
          endsAt: new Date(startsAt.getTime() + 30 * 60 * 1000),
          isTentative: false,
          completionStatus: "SCHEDULED",
        },
      ],
      source: {
        requestedBy: { user: { id: "u-learner" } },
        consultationPlan: { consultantProfile: { user: { id: "u-expert" } } },
      },
    },
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

beforeEach(() => {
  jest.clearAllMocks();
  mockSession = null;
  window.matchMedia = jest.fn().mockReturnValue({
    matches: true,
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
  });
});

describe("consultee appointments overflow", () => {
  const overflow = () =>
    renderHook(() => useConsulteeAppointmentsAdapter(), {
      wrapper,
    }).result.current.overflowItems(vm());

  it("keeps Reschedule and Cancel for the learner", () => {
    mockSession = {
      id: "u-learner",
      role: "USER",
      consulteeProfileId: "ce-learner",
    };
    expect(keys(overflow())).toEqual(
      expect.arrayContaining(["reschedule", "cancel"]),
    );
    expect(keys(overflow())).not.toContain("ops-hint");
  });

  it("swaps them for the Ops panel hint for STAFF inspecting the learner", () => {
    mockSession = { id: "u-staff", role: "STAFF" };
    const items = overflow();
    expect(keys(items)).not.toContain("reschedule");
    expect(keys(items)).not.toContain("cancel");
    const hint = items.find((item) => item.key === "ops-hint");
    expect(hint).toMatchObject({ label: OPS_HINT_LABEL, href: OPS });
    hint?.onClick();
    expect(mockPush).toHaveBeenCalledWith(OPS);
  });

  it("keeps them for an ADMIN who is the booking's consultant", () => {
    mockSession = {
      id: "u-expert",
      role: "ADMIN",
      consultantProfileId: "ca-expert",
    };
    expect(keys(overflow())).toEqual(
      expect.arrayContaining(["reschedule", "cancel"]),
    );
  });

  it("keeps them for an operator on their own dashboard", () => {
    mockSession = {
      id: "u-other",
      role: "ADMIN",
      consulteeProfileId: "ce-learner",
    };
    expect(keys(overflow())).not.toContain("ops-hint");
  });
});

describe("consultant appointments overflow", () => {
  const overflow = () =>
    renderHook(() => useConsultantAppointmentsAdapter("ca-expert"), {
      wrapper,
    }).result.current.overflowItems(vm());

  it("keeps Reschedule and Cancel for the consultant", () => {
    mockSession = {
      id: "u-expert",
      role: "USER",
      consultantProfileId: "ca-expert",
    };
    expect(keys(overflow())).toEqual(
      expect.arrayContaining(["reschedule", "cancel"]),
    );
    expect(keys(overflow())).not.toContain("ops-hint");
  });

  it("swaps them for the Ops panel hint for an ADMIN inspecting the consultant", () => {
    mockSession = { id: "u-admin", role: "ADMIN" };
    const items = overflow();
    expect(keys(items)).not.toContain("reschedule");
    expect(keys(items)).not.toContain("cancel");
    expect(items.find((item) => item.key === "ops-hint")).toMatchObject({
      label: OPS_HINT_LABEL,
      href: ADMIN_OPS,
    });
  });

  it("keeps them for STAFF who booked the session as the learner", () => {
    mockSession = { id: "u-learner", role: "STAFF" };
    expect(keys(overflow())).toEqual(
      expect.arrayContaining(["reschedule", "cancel"]),
    );
  });
});

describe("OrgActorDetail", () => {
  const props = {
    orgId: "org-1",
    orgName: "Acme",
    appointmentId: APPT,
    meta: {
      title: "Career chat",
      kind: "CONSULTATION" as const,
      status: "APPROVED" as const,
      expertName: "Expert",
      learnerName: "Learner",
      learnerUserId: "u-learner",
      consultantProfileId: "cp-1",
      sessionMinutes: 60,
      sessions: [],
    },
    canCancel: true,
    canReschedule: true,
    isSubscription: false,
  };

  it("offers the org's Reschedule and Cancel to an org operator", () => {
    render(<OrgActorDetail {...props} />, { wrapper });
    expect(
      screen.getByRole("button", { name: "Reschedule" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Cancel booking" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Ops panel" })).toBeNull();
  });

  it("words a hosted webinar as the event and prints its sessions in labelled India time", () => {
    const draft: string = "DRAFT";
    render(
      <OrgActorDetail
        {...props}
        canCancel={false}
        canReschedule={false}
        meta={{
          ...props.meta,
          title: "Workshop",
          kind: "WEBINAR" as const,
          // An event's status rides the same prop as a booking's.
          status: draft as OrgActorDetailProps["meta"]["status"],
          learnerName: null,
          learnerUserId: null,
          sessions: [
            {
              id: "occ-1",
              startsAt: new Date("2026-11-23T17:00:00.000Z"),
              endsAt: new Date("2026-11-23T18:00:00.000Z"),
            },
          ],
        }}
      />,
      { wrapper },
    );
    expect(screen.getByText("Draft")).toBeInTheDocument();
    expect(screen.queryByText("Registered")).toBeNull();
    expect(screen.getByText(/10:30 pm IST/)).toBeInTheDocument();
  });

  it("shows a platform operator the Ops panel link instead", () => {
    render(<OrgActorDetail {...props} opsHref={OPS} />, { wrapper });
    expect(screen.queryByRole("button", { name: "Reschedule" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Cancel booking" })).toBeNull();
    expect(screen.queryByText(/Acting for Acme/)).toBeNull();
    expect(screen.getByRole("link", { name: "Ops panel" })).toHaveAttribute(
      "href",
      OPS,
    );
  });
});

describe("consultee reschedule page", () => {
  const detail = {
    appointment: {
      appointmentType: "CONSULTATION",
      participants: [],
      consultation: {
        requestedBy: { id: "ce-learner", userId: "u-learner" },
        consultationPlan: { consultantProfile: { userId: "u-expert" } },
      },
    },
  };

  async function renderPage() {
    mockReadDetail.mockResolvedValue(detail);
    render(
      await ConsulteeReschedulePage({
        params: Promise.resolve({
          consulteeId: "ce-learner",
          appointmentId: APPT,
        }),
        searchParams: Promise.resolve({}),
      }),
    );
  }

  it("draws the picker for the learner", async () => {
    mockAccess.mockResolvedValue({ userId: "u-learner", isInspecting: false });
    await renderPage();
    expect(screen.getByText("time picker")).toBeInTheDocument();
  });

  it("points STAFF who is not a party at the Ops panel", async () => {
    mockAccess.mockResolvedValue({ userId: "u-staff", isInspecting: true });
    mockGetSession.mockResolvedValue({
      user: { id: "u-staff", role: "STAFF" },
    });
    await renderPage();
    expect(screen.queryByText("time picker")).toBeNull();
    expect(screen.getByRole("link", { name: "Ops panel" })).toHaveAttribute(
      "href",
      OPS,
    );
  });

  it("draws the picker for an ADMIN who is the consultant", async () => {
    mockAccess.mockResolvedValue({ userId: "u-expert", isInspecting: true });
    mockGetSession.mockResolvedValue({
      user: { id: "u-expert", role: "ADMIN" },
    });
    await renderPage();
    expect(screen.getByText("time picker")).toBeInTheDocument();
  });
});

describe("reschedule page metadata", () => {
  it("names nothing to a viewer who does not own the profile in the URL", async () => {
    mockOwns.mockResolvedValue(false);
    mockReadDetail.mockClear();
    const meta = await consulteeRescheduleMetadata({
      params: Promise.resolve({ consulteeId: "ce-1", appointmentId: "a-1" }),
      searchParams: Promise.resolve({}),
    });
    expect(meta).toEqual({ title: "Reschedule — Familiarise" });
    expect(mockReadDetail).not.toHaveBeenCalled();
  });
});
