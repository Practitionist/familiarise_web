/**
 * @jest-environment node
 */

/**
 * STAFF who are not a party read a learner in the public shape on the learner
 * list, the trial read and the consultant appointment rows; ADMIN, the owner
 * and a party read it in full. The consultation read is covered beside its
 * status refusals.
 */

import { NextRequest } from "next/server";

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
const mockTrial = jest.fn();

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    consulteeProfile: { findMany: (...a: unknown[]) => mockFindMany(...a) },
    trial: { findUnique: (...a: unknown[]) => mockTrial(...a) },
  },
}));
jest.mock("../../lib/auth-helpers", () =>
  jest
    .requireActual("../fixtures/route-auth-mock")
    .routeAuthMock(() => caller.current),
);
jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));
jest.mock("../../lib/novu", () => ({}));
jest.mock("../../lib/email/senders/booking", () => ({}));
jest.mock("../../lib/novu/stage-then-attempt", () => ({}));

import { GET as listLearners } from "../../app/api/user/consultees/route";
import { GET as readTrial } from "../../app/api/trials/[trialId]/route";
import { withPublicRequesterForStaff } from "../../lib/data/consultant-appointments";
import { publicProfileUserSelect } from "../../lib/data/consultant-public";
import type { ConsultantListAppointment } from "../../lib/data/consultant-appointments";

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

describe("the trial detail read", () => {
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
