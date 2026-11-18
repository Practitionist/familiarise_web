/**
 * A row that reads Cancelled offers nothing live. Stored lapsed bookings go
 * through the real list readers' query shape and mappers, then through the
 * learner's and the expert's real adapters; their menus and primary actions
 * may hold only neutral items.
 */

import * as React from "react";
import { renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { projectRow } from "../fixtures/prisma-projection";
import {
  NOW,
  storedConsultation,
  storedSeat,
  storedTrial,
} from "../fixtures/stored-bookings";

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), refresh: jest.fn() }),
  useParams: () => ({ consulteeId: "cee-1" }),
}));
jest.mock("@/lib/auth-client", () => ({
  useSession: () => ({
    data: { user: { id: "u-l", consulteeProfileId: "cee-1", role: "USER" } },
  }),
}));
jest.mock("@/hooks/scheduling/useLazyJoinMeeting", () => ({
  useLazyJoinMeeting: () => jest.fn(),
}));
jest.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: jest.fn() }),
}));
jest.mock("@/components/appointments/consultee/useEventActions", () => ({
  useEventActions: () => ({ handleCancelConfirm: jest.fn(), isLoading: false }),
}));
jest.mock(
  "@/app/dashboard/consultant/[consultantId]/(features)/appointments/components/useConsultantEventActions",
  () => ({
    useConsultantEventActions: () => ({
      handleCancelConfirm: jest.fn(),
      handleRetime: jest.fn(),
      isLoading: false,
    }),
  }),
);
jest.mock(
  "@/components/appointments/consultee/CancelConfirmationDialog",
  () => ({
    CancelConfirmationDialog: () => null,
  }),
);
jest.mock("@/components/appointments/RetimeDialog", () => ({
  RetimeDialog: () => null,
}));

type Row = Record<string, unknown>;
const mockRows: Record<string, Row[]> = {};
const mockFind = (model: string) => (args: Row) =>
  Promise.resolve((mockRows[model] ?? []).map((r) => projectRow(r, args)));
jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  default: {
    appointment: { findMany: (a: Row) => mockFind("appointment")(a) },
    consulteeProfile: { findUnique: () => Promise.resolve({ userId: "u-l" }) },
    consultation: { findMany: (a: Row) => mockFind("consultation")(a) },
    subscription: { findMany: () => Promise.resolve([]) },
    webinar: { findMany: (a: Row) => mockFind("webinar")(a) },
    class: { findMany: () => Promise.resolve([]) },
    trial: { findMany: (a: Row) => mockFind("trial")(a) },
  },
}));
jest.mock("@/lib/appointments/report-anomalies", () => ({
  bookingAnomalies: () => [],
  scheduleAnomalyReport: () => undefined,
}));

import { readConsulteeEvents } from "@/lib/data/consultee-events-read";
import { readConsultantAppointmentsPage } from "@/lib/data/consultant-appointments";
import { mapConsulteeEvents } from "@/lib/appointments/map-consultee";
import { mapConsultantAppointments } from "@/lib/appointments/map-consultant";
import { appointmentStatusChip } from "@/lib/appointments/occurrences";
import type { AppointmentActionAdapter } from "@/lib/appointments/adapter";
import type { AppointmentVM } from "@/lib/appointments/view-model";
import { useConsulteeAppointmentsAdapter } from "@/components/appointments/consultee/ConsulteeAppointmentsAdapter";
import { useConsultantAppointmentsAdapter } from "@/app/dashboard/consultant/[consultantId]/(features)/appointments/ConsultantAppointmentsAdapter";

/** Items that change nothing: reading the booking or asking for help. */
const NEUTRAL = new Set(["report", "documents"]);

function reset() {
  for (const key of Object.keys(mockRows)) delete mockRows[key];
}

function wrapper({ children }: { children: React.ReactNode }) {
  return (
    <QueryClientProvider client={new QueryClient()}>
      {children}
    </QueryClientProvider>
  );
}

function offered(adapter: AppointmentActionAdapter, vm: AppointmentVM) {
  return {
    word: appointmentStatusChip(vm, adapter.role).label,
    bucket: vm.bucket,
    primary: adapter.primaryAction(vm).kind,
    menu: adapter.overflowItems(vm).map((i) => i.key),
  };
}

async function learnerRow(seed: () => void) {
  reset();
  seed();
  const events = await readConsulteeEvents("cee-1", { kind: "personal" });
  const [vm] = mapConsulteeEvents(events, NOW);
  const { result } = renderHook(() => useConsulteeAppointmentsAdapter(), {
    wrapper,
  });
  return offered(result.current, vm);
}

async function expertRow(seed: () => { rows?: Row[]; trials?: Row[] }) {
  reset();
  const { rows = [], trials = [] } = seed();
  mockRows.appointment = rows;
  const page = await readConsultantAppointmentsPage({
    consultantProfileId: "cp-1",
    scope: { kind: "personal" },
    now: NOW,
  } as Parameters<typeof readConsultantAppointmentsPage>[0]);
  const [vm] = mapConsultantAppointments(
    {
      consultantId: "cp-1",
      appointments: page.rows.slice(0, 1),
      scheduledTrials: trials,
    } as unknown as Parameters<typeof mapConsultantAppointments>[0],
    NOW,
  );
  const { result } = renderHook(
    () => useConsultantAppointmentsAdapter("cp-1"),
    {
      wrapper,
    },
  );
  return offered(result.current, vm);
}

const lapsed1to1 = () => {
  const { consultation, appointment } = storedConsultation("PENDING", "lapsed");
  return { consultation, appointment };
};

describe("a row that reads Cancelled offers only neutral actions", () => {
  it.each([
    [
      "learner · lapsed 1:1 hold",
      () =>
        learnerRow(() => {
          const { consultation, appointment } = lapsed1to1();
          mockRows.consultation = [{ ...consultation, appointment }];
        }),
    ],
    [
      "learner · lapsed webinar seat",
      () =>
        learnerRow(() => {
          mockRows.webinar = [storedSeat("lapsed")];
        }),
    ],
    [
      "learner · lapsed trial",
      () =>
        learnerRow(() => {
          mockRows.trial = [storedTrial(false)];
        }),
    ],
    [
      "expert · lapsed 1:1 hold",
      () =>
        expertRow(() => {
          const { consultation, appointment } = lapsed1to1();
          return { rows: [{ ...appointment, consultation }] };
        }),
    ],
    [
      "expert · lapsed trial",
      () => expertRow(() => ({ trials: [storedTrial(false)] })),
    ],
  ])("%s", async (_row, read) => {
    const row = await read();
    expect(row.word).toBe("Cancelled");
    expect(row.bucket).toBe("cancelled");
    expect(row.primary).toBe("view");
    expect(row.menu.filter((key) => !NEUTRAL.has(key))).toEqual([]);
  });
});

describe("the roster is offered only to someone who may open it", () => {
  /** A paid webinar on the expert's list, by who owns the plan and who is on its team. */
  const webinarRow = (ownerId: string, collaborators: Row[]) =>
    expertRow(() => {
      const { appointment, ...webinar } = storedSeat("paid");
      const webinarPlan = {
        ...webinar.webinarPlan,
        consultantProfileId: ownerId,
        collaborators,
      };
      return {
        rows: [{ ...appointment, webinar: { ...webinar, webinarPlan } }],
      };
    });
  const onTeamAs = (role: string) => [
    { id: "collab-1", consultantProfileId: "cp-1", role, status: "ACCEPTED" },
  ];

  it.each([
    ["the plan's host", () => webinarRow("cp-1", []), true],
    ["a co-host", () => webinarRow("cp-host", onTeamAs("CO_HOST")), true],
    [
      "technical support",
      () => webinarRow("cp-host", onTeamAs("TECHNICAL_SUPPORT")),
      false,
    ],
    ["a moderator", () => webinarRow("cp-host", onTeamAs("MODERATOR")), false],
  ])("%s", async (_viewer, read, offeredRoster) => {
    const row = await read();
    expect(row.menu.includes("participants")).toBe(offeredRoster);
  });
});
