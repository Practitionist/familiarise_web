/**
 * A learner's booking page links to the expert's public profile ("Book
 * again", "Continue with <expert>", the trial's next step) only when that page
 * is served; the detail read says so without shipping the verification status.
 */

const findUnique = jest.fn();
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    appointment: { findUnique: (...a: unknown[]) => findUnique(...a) },
  },
}));
// "Book again" is the RequestAgainButton, which needs the app router.
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), refresh: jest.fn() }),
}));
jest.mock("@/lib/auth-client", () => ({
  useSession: () => ({ data: null }),
}));
jest.mock("../../lib/appointments/report-anomalies", () => ({
  bookingAnomalies: () => [],
  scheduleAnomalyReport: () => undefined,
}));

import * as React from "react";
import { render } from "@testing-library/react";
import { readAppointmentDetail } from "@/lib/data/appointment-detail";
import { mapAppointmentDetail } from "@/lib/appointments/map-detail";
import {
  ConsulteeExtraActions,
  TrialContinueCard,
} from "@/app/dashboard/consultee/[consulteeId]/(features)/appointments/[appointmentId]/DetailPageClient";

const DAY = 86_400_000;
const user = (id: string, name: string) => ({
  id,
  name,
  image: null,
  timezone: "Asia/Kolkata",
});
const expert = (verificationStatus: string, deletedAt: Date | null) => ({
  id: "cp_michael",
  userId: "u_michael",
  user: user("u_michael", "Michael Anderson"),
  verificationStatus,
  deletedAt,
});
const heldOccurrence = {
  id: "occ_1",
  appointmentId: "appt_1",
  startsAt: new Date(Date.now() - 3 * DAY),
  endsAt: new Date(Date.now() - 3 * DAY + 3_600_000),
  isTentative: false,
  completionStatus: "COMPLETED",
  deletedAt: null,
  meeting: null,
};
const base = {
  id: "appt_1",
  deletedAt: null,
  organizationId: null,
  organization: null,
  webinarId: null,
  classId: null,
  consultation: null,
  subscription: null,
  webinar: null,
  class: null,
  trial: null,
  payment: [],
  rescheduleRequests: [],
  occurrences: [heldOccurrence],
  statusHistory: [],
  participants: [],
};
const consultationRow = (profile: ReturnType<typeof expert>) => ({
  ...base,
  appointmentType: "CONSULTATION",
  consultation: {
    id: "c_1",
    status: "COMPLETED",
    pendingPaymentUrl: null,
    consultationPlan: {
      title: "Career consultation",
      consultantProfile: profile,
    },
    requestedBy: {
      id: "ce_daniel",
      userId: "u_daniel",
      user: { ...user("u_daniel", "Daniel Brown"), email: "d@test" },
    },
  },
});
const trialRow = (profile: ReturnType<typeof expert>) => ({
  ...base,
  appointmentType: "TRIAL",
  trial: {
    id: "t_1",
    status: "COMPLETED",
    consulteeProfile: {
      id: "ce_daniel",
      userId: "u_daniel",
      user: user("u_daniel", "Daniel Brown"),
    },
    consultantProfile: profile,
    subscriptionPlan: { title: "Trial", consultantProfile: profile },
  },
});

async function vmFor(row: unknown) {
  findUnique.mockResolvedValue(row);
  const detail = await readAppointmentDetail("appt_1");
  if (!detail) throw new Error("no detail");
  return { detail, vm: mapAppointmentDetail(detail, "consultee").vm };
}

const profileLinks = (container: HTMLElement) =>
  Array.from(container.querySelectorAll('a[href^="/explore/experts/"]')).map(
    (a) => a.textContent,
  );

it.each([
  ["VERIFIED", null, ["Continue with Michael Anderson", "Book again"]],
  ["PENDING_VERIFICATION", null, []],
  ["VERIFIED", new Date("2026-11-19T00:00:00.000Z"), []],
])(
  "a %s expert (deleted %s) gets the profile links %j",
  async (status, deletedAt, links) => {
    const { detail, vm } = await vmFor(
      consultationRow(expert(status, deletedAt)),
    );
    expect(JSON.stringify(detail)).not.toMatch(
      /verificationStatus|PENDING_VERIFICATION/,
    );
    const { container } = render(
      <ConsulteeExtraActions
        vm={vm}
        consulteeId="ce_daniel"
        appointmentId="appt_1"
        hasOverflowMessageAction
        openChat={jest.fn()}
      />,
    );
    expect(profileLinks(container)).toEqual(links);
  },
);

it.each([
  ["VERIFIED", 1],
  ["PENDING_VERIFICATION", 0],
])(
  "a completed trial with a %s expert offers %i profile link",
  async (status, n) => {
    const { vm } = await vmFor(trialRow(expert(status, null)));
    const { container } = render(<TrialContinueCard vm={vm} />);
    expect(profileLinks(container)).toHaveLength(n);
  },
);
