/**
 * @jest-environment node
 */

/**
 * The booking detail tells each viewer whether the withdraw route would take
 * the open reschedule back from them. It asks the route's own authority, so
 * the page and the route cannot disagree.
 */

const mockSponsorAdmins = new Set<string>();
const mockSuspended = jest.fn(async () => false);
jest.mock("../../lib/prisma", () => ({ __esModule: true, default: {} }));
jest.mock("../../utils/appointmentlock", () => ({
  __esModule: true,
  withAppointmentLock: jest.fn(),
}));
jest.mock("../../lib/auth-helpers", () => ({
  resolveEventHostActor: jest.fn(
    async (session: { user: { consultantProfileId: string | null } }) =>
      session.user.consultantProfileId === "cp-1" ? "consultant" : null,
  ),
}));
jest.mock("../../lib/booking/org-actor", () => ({
  isOrgAdminOfAppointment: jest.fn(async (userId: string) =>
    mockSponsorAdmins.has(userId),
  ),
}));
jest.mock("../../lib/enterprise/suspended-member-sessions", () => ({
  isSuspendedInFundingOrg: (...a: unknown[]) => mockSuspended(...(a as [])),
}));

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Session } from "@/lib/auth";
import {
  scopeAppointmentDetail,
  viewerMayWithdrawReschedule,
  type TAppointmentDetail,
} from "@/lib/data/appointment-detail";

const sessionOf = (id: string, consultantProfileId: string | null = null) =>
  ({
    user: { id, role: "CONSULTEE", consultantProfileId },
  }) as unknown as Session;

const LEARNER = sessionOf("u-buyer");
const EXPERT = sessionOf("u-expert", "cp-1");

/** A consultation with one open move, opened by `initiatedById` for `initiatorRole`. */
function detailWith(
  open: { initiatedById: string; initiatorRole: string } | null,
) {
  return {
    appointment: {
      id: "apt-1",
      consultationId: "con-1",
      subscriptionId: null,
      webinarId: null,
      classId: null,
      organizationId: "org-1",
      consultation: {
        requestedBy: { userId: "u-buyer" },
        consultationPlan: { consultantProfile: { userId: "u-expert" } },
      },
      subscription: null,
      trial: null,
      participants: [],
      payment: [],
      rescheduleRequests: open ? [{ id: "rr-1", ...open }] : [],
    },
  } as unknown as TAppointmentDetail;
}

const sponsorMove = () => {
  mockSponsorAdmins.add("u-sponsor");
  return detailWith({ initiatedById: "u-sponsor", initiatorRole: "CONSULTEE" });
};

beforeEach(() => {
  mockSponsorAdmins.clear();
  mockSuspended.mockResolvedValue(false);
});

describe("viewerMayWithdrawReschedule", () => {
  it("says yes to the learner for a move the sponsor's admin opened", async () => {
    expect(await viewerMayWithdrawReschedule(sponsorMove(), LEARNER)).toBe(
      true,
    );
  });

  it("says no to the other side of that move", async () => {
    expect(await viewerMayWithdrawReschedule(sponsorMove(), EXPERT)).toBe(
      false,
    );
  });

  it("says no to a learner suspended in the organisation funding the booking", async () => {
    mockSuspended.mockResolvedValue(true);
    expect(await viewerMayWithdrawReschedule(sponsorMove(), LEARNER)).toBe(
      false,
    );
  });

  it("says yes to the initiator, and no to the sponsor's admin for the learner's own move", async () => {
    const own = detailWith({
      initiatedById: "u-buyer",
      initiatorRole: "CONSULTEE",
    });
    mockSponsorAdmins.add("u-sponsor");
    expect(await viewerMayWithdrawReschedule(own, LEARNER)).toBe(true);
    expect(await viewerMayWithdrawReschedule(own, sessionOf("u-sponsor"))).toBe(
      false,
    );
  });

  it("says no with no open move or no session", async () => {
    expect(await viewerMayWithdrawReschedule(detailWith(null), LEARNER)).toBe(
      false,
    );
    expect(await viewerMayWithdrawReschedule(sponsorMove(), null)).toBe(false);
  });
});

describe("scopeAppointmentDetail", () => {
  const viewer = { userId: "u-buyer", managesGroupPlan: false };

  it("stamps the viewer's answer on the open move", () => {
    const scoped = scopeAppointmentDetail(sponsorMove(), {
      ...viewer,
      mayWithdrawReschedule: true,
    });
    expect(scoped.appointment.rescheduleRequests[0]).toMatchObject({
      id: "rr-1",
      viewerMayWithdraw: true,
    });
  });

  it("reads a viewer nobody asked about as no", () => {
    const scoped = scopeAppointmentDetail(sponsorMove(), viewer);
    expect(scoped.appointment.rescheduleRequests[0].viewerMayWithdraw).toBe(
      false,
    );
  });
});

it("a read-only proposal card offers no way to keep the original time", () => {
  const card = readFileSync(
    join(
      process.cwd(),
      "components/appointments/detail/RescheduleProposalCard.tsx",
    ),
    "utf8",
  );
  expect(card).toMatch(
    /const keepsOwnTime =\s*!readOnly && !isInitiator && proposal\.viewerMayWithdraw === true;/,
  );
});
