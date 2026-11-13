/**
 * @jest-environment node
 */

/**
 * STAFF who are not a party read a learner in the public shape on the learner
 * list and on every booking read that embeds the requester; ADMIN, the owner
 * and a party read it in full.
 */

import { NextRequest, NextResponse } from "next/server";

const caller = { current: {} as Record<string, unknown> };
const LEARNER_ONLY = {
  aboutMe: "Private",
  goals: "Private",
  careerStage: "STUDENT",
  skillsToDevelop: ["x"],
  budgetPreference: "BUDGET",
  billingStateCode: "29",
};
const requester = () => ({
  id: "cee-1",
  userId: "u-learner",
  ...LEARNER_ONLY,
  user: {
    id: "u-learner",
    name: "Priya",
    email: "priya@x.test",
    image: null,
  },
});
const mockFindMany = jest.fn();
const mockConsultation = jest.fn();
const mockTrial = jest.fn();

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    consulteeProfile: { findMany: (...a: unknown[]) => mockFindMany(...a) },
    consultation: {
      findUniqueOrThrow: (...a: unknown[]) => mockConsultation(...a),
    },
    trial: { findUnique: (...a: unknown[]) => mockTrial(...a) },
  },
}));
jest.mock("../../lib/auth-helpers", () => ({
  __esModule: true,
  requireApiAuth: jest.fn(async () => ({ session: { user: caller.current } })),
  isPrivileged: (role: string) => role === "ADMIN" || role === "STAFF",
  forbiddenResponse: (error: string) =>
    NextResponse.json({ error }, { status: 403 }),
}));
jest.mock("../../lib/rate-limit", () => ({
  applyRateLimit: jest.fn(async () => null),
  eventMutationLimiter: {},
}));
jest.mock("../../actions/stream/chat/channel.action", () => ({
  createDirectMessageChannel: jest.fn(),
}));
jest.mock("../../lib/stream-logger", () => ({ streamLogger: {} }));
jest.mock("../../lib/stream-utils", () => ({ bookingOrgId: jest.fn() }));
jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));
jest.mock("../../lib/novu", () => ({}));
jest.mock("../../lib/email/senders/booking", () => ({}));
jest.mock("../../lib/novu/stage-then-attempt", () => ({}));

import { GET as listLearners } from "../../app/api/user/consultees/route";
import { GET as readConsultation } from "../../app/api/bookings/consultations/[consultationId]/route";
import { GET as readTrial } from "../../app/api/trials/[trialId]/route";
import { withPublicRequesterForStaff } from "../../lib/data/consultant-appointments";
import { publicProfileUserSelect } from "../../lib/data/consultant-public";
import type { ConsultantListAppointment } from "../../lib/data/consultant-appointments";

const ID = "0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d";
const PUBLIC_REQUESTER = {
  id: "cee-1",
  userId: "u-learner",
  user: { id: "u-learner", name: "Priya", image: null },
};
const as = (role: string, profiles: Record<string, string | null> = {}) => {
  caller.current = {
    id: "u-caller",
    role,
    consultantProfileId: null,
    consulteeProfileId: null,
    ...profiles,
  };
};

beforeEach(() => {
  jest.clearAllMocks();
  mockFindMany.mockResolvedValue([]);
  mockConsultation.mockResolvedValue({
    id: ID,
    requestedById: "cee-1",
    consultationPlan: { consultantProfile: { id: "cp-1" } },
    requestedBy: requester(),
  });
  mockTrial.mockResolvedValue({
    id: "trial-1",
    consulteeProfileId: "cee-1",
    consultantProfileId: "cp-1",
    consulteeProfile: requester(),
  });
});

describe("the learner list", () => {
  const list = () =>
    listLearners(new NextRequest("http://localhost/api/user/consultees"));

  it("gives STAFF the public profile shape only", async () => {
    as("STAFF");
    await list();
    expect(mockFindMany.mock.calls[0][0]).toMatchObject({
      select: {
        id: true,
        userId: true,
        user: { select: publicProfileUserSelect },
      },
    });
  });

  it("gives ADMIN the whole record", async () => {
    as("ADMIN");
    await list();
    expect(mockFindMany.mock.calls[0][0]).toHaveProperty("include");
  });
});

describe("a booking read that embeds the requester", () => {
  const consultation = async () =>
    (
      await (
        await readConsultation(
          new NextRequest(`http://localhost/api/bookings/consultations/${ID}`),
          { params: Promise.resolve({ consultationId: ID }) },
        )
      ).json()
    ).data.requestedBy;
  const trial = async () =>
    (
      await (
        await readTrial(
          new NextRequest("http://localhost/api/trials/trial-1"),
          {
            params: Promise.resolve({ trialId: "trial-1" }),
          },
        )
      ).json()
    ).data.consulteeProfile;

  it("shows a non-party STAFF user the public shape", async () => {
    as("STAFF");
    expect(await consultation()).toEqual(PUBLIC_REQUESTER);
    expect(await trial()).toEqual(PUBLIC_REQUESTER);
  });

  it.each([
    ["ADMIN", () => as("ADMIN")],
    [
      "STAFF who is the learner",
      () => as("STAFF", { consulteeProfileId: "cee-1" }),
    ],
    ["the expert", () => as("CONSULTANT", { consultantProfileId: "cp-1" })],
  ])("shows %s the whole requester", async (_who, become) => {
    become();
    expect(await consultation()).toMatchObject(LEARNER_ONLY);
    expect(await trial()).toMatchObject(LEARNER_ONLY);
  });
});

describe("the consultant appointments rows", () => {
  const row = {
    consultation: {
      consultationPlan: { consultantProfile: { id: "cp-1" } },
      requestedBy: requester(),
    },
    subscription: null,
  } as unknown as ConsultantListAppointment;

  it("narrow the requester for STAFF who are not a party", () => {
    const seen = withPublicRequesterForStaff(row, { role: "STAFF" });
    expect(seen.consultation?.requestedBy).toEqual(PUBLIC_REQUESTER);
  });

  it("leave a party and ADMIN unchanged", () => {
    expect(
      withPublicRequesterForStaff(row, {
        role: "STAFF",
        consultantProfileId: "cp-1",
      }),
    ).toBe(row);
    expect(withPublicRequesterForStaff(row, { role: "ADMIN" })).toBe(row);
  });
});
