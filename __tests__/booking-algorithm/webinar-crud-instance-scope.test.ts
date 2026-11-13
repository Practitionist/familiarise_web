/**
 * @jest-environment node
 */

/**
 * A PATCH's webinarId must name an instance of the plan being edited, and an
 * organisation's plan is edited only by an ACTIVE EXPERT member of it.
 */

const mockTx = {
  webinarPlan: { update: jest.fn() },
  webinar: {
    findUnique: jest.fn(),
    updateMany: jest.fn(),
    findUniqueOrThrow: jest.fn(),
  },
  bookingStatusHistory: { create: jest.fn() },
};

const transaction = jest.fn();
const memberships: Array<Record<string, string>> = [];

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    $transaction: (...args: unknown[]) => transaction(...args),
    webinarPlan: { findUnique: jest.fn() },
    consultantProfile: { findUnique: jest.fn() },
    webinar: { findFirst: jest.fn() },
    membership: {
      count: jest.fn(
        async ({ where }: { where: Record<string, string> }) =>
          memberships.filter((m) =>
            Object.entries(where).every(([key, value]) => m[key] === value),
          ).length,
      ),
    },
  },
}));

jest.mock("../../lib/auth-server", () => ({
  __esModule: true,
  getSession: jest.fn().mockResolvedValue({ user: { id: "user-1" } }),
}));

jest.mock("../../utils/contentValidation", () =>
  jest.requireActual("../fixtures/content-validation-stub"),
);

jest.mock("../../lib/topics", () => ({
  __esModule: true,
  findOrCreateTopics: jest.fn().mockResolvedValue(["topic-1"]),
  transformNestedPlanTopics: jest.fn((row: unknown) => row),
}));

import prisma from "@/lib/prisma";
import { PATCH } from "@/app/api/bookings/webinars/crud-with-plan/route";
import { findOrCreateTopics } from "@/lib/topics";

const base = prisma as unknown as Record<string, Record<string, jest.Mock>>;

const PLAN = {
  id: "plan-1",
  consultantProfileId: "cp-1",
  consultantProfile: { id: "cp-1", userId: "user-1" },
  durationInHours: 1,
  topics: [],
  webinars: [],
};
const WEBINAR = { id: "web-1", status: "SCHEDULED", appointment: null };

function request(body: unknown) {
  return { json: async () => body } as unknown as Parameters<typeof PATCH>[0];
}

beforeEach(() => {
  transaction.mockImplementation(async (callback: (tx: unknown) => unknown) =>
    callback(mockTx),
  );
  base.webinarPlan.findUnique.mockResolvedValue(PLAN);
  mockTx.webinarPlan.update.mockResolvedValue(PLAN);
  mockTx.webinar.findUnique.mockResolvedValue(WEBINAR);
});

describe("webinar PATCH scopes webinarId to the plan", () => {
  it("404s a webinarId from another plan without writing", async () => {
    base.webinar.findFirst.mockResolvedValue(null);

    const response = await PATCH(
      request({ id: "plan-1", webinarId: "web-other", title: "Renamed" }),
    );

    expect(response.status).toBe(404);
    expect(base.webinar.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "web-other", webinarPlanId: "plan-1" },
      }),
    );
    expect(transaction).not.toHaveBeenCalled();
  });

  it("updates when the webinarId belongs to the plan", async () => {
    base.webinar.findFirst.mockResolvedValue(WEBINAR);

    const response = await PATCH(
      request({ id: "plan-1", webinarId: "web-1", title: "Renamed" }),
    );

    expect(response.status).toBe(200);
    expect(mockTx.webinarPlan.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "plan-1" },
        data: expect.objectContaining({ title: "Renamed" }),
      }),
    );
  });
});

describe("webinar PATCH only moves a plan to a profile the caller owns", () => {
  beforeEach(() => {
    base.webinar.findFirst.mockResolvedValue(WEBINAR);
  });

  it("403s a profile owned by another user without writing", async () => {
    base.consultantProfile.findUnique.mockResolvedValue({ userId: "user-2" });

    const response = await PATCH(
      request({ id: "plan-1", consultantProfileId: "cp-other" }),
    );

    expect(response.status).toBe(403);
    expect(transaction).not.toHaveBeenCalled();
  });

  it("allows another profile the caller owns", async () => {
    base.consultantProfile.findUnique.mockResolvedValue({ userId: "user-1" });

    const response = await PATCH(
      request({ id: "plan-1", consultantProfileId: "cp-2" }),
    );

    expect(response.status).toBe(200);
    expect(transaction).toHaveBeenCalled();
  });

  it("skips the ownership lookup when the profile is unchanged", async () => {
    base.consultantProfile.findUnique.mockClear();

    const response = await PATCH(
      request({ id: "plan-1", consultantProfileId: "cp-1" }),
    );

    expect(response.status).toBe(200);
    expect(base.consultantProfile.findUnique).not.toHaveBeenCalled();
  });
});

describe("webinar PATCH moves status only along the publish edge", () => {
  it("publishes a DRAFT through the CAS helper, matching DRAFT only", async () => {
    const draft = { ...WEBINAR, status: "DRAFT" };
    base.webinar.findFirst.mockResolvedValue(draft);
    mockTx.webinar.findUnique.mockResolvedValue(draft);
    mockTx.webinar.updateMany.mockResolvedValue({ count: 1 });
    mockTx.webinar.findUniqueOrThrow.mockResolvedValue({
      ...draft,
      status: "SCHEDULED",
    });

    const response = await PATCH(
      request({ id: "plan-1", webinarId: "web-1", status: "SCHEDULED" }),
    );

    expect(response.status).toBe(200);
    expect(mockTx.webinar.updateMany).toHaveBeenCalledWith({
      where: { id: "web-1", status: { in: ["DRAFT"] } },
      data: { status: "SCHEDULED" },
    });
  });
});

describe("webinar PATCH on an organisation's plan", () => {
  const member = (status: string) => ({
    organizationId: "org-1",
    consultantProfileId: "cp-1",
    role: "EXPERT",
    status,
  });

  beforeEach(() => {
    memberships.length = 0;
    base.webinar.findFirst.mockResolvedValue(WEBINAR);
    base.webinarPlan.findUnique.mockResolvedValue({
      ...PLAN,
      organizationId: "org-1",
    });
  });

  it.each(["REMOVED", "SUSPENDED"])(
    "refuses the named expert whose membership is %s",
    async (status) => {
      memberships.push(member(status));
      const response = await PATCH(
        request({ id: "plan-1", price: 99_900, topics: ["new-topic"] }),
      );
      expect(response.status).toBe(403);
      expect((await response.json()).code).toBe("NOT_ACTIVE_ORG_EXPERT");
      expect(transaction).not.toHaveBeenCalled();
      expect(findOrCreateTopics).not.toHaveBeenCalled();
    },
  );

  it("lets an active expert member edit", async () => {
    memberships.push(member("ACTIVE"));
    const response = await PATCH(request({ id: "plan-1", title: "Renamed" }));
    expect(response.status).toBe(200);
  });

  it("leaves a personal plan to its expert with no membership read", async () => {
    base.webinarPlan.findUnique.mockResolvedValue(PLAN);
    const response = await PATCH(request({ id: "plan-1", title: "Renamed" }));
    expect(response.status).toBe(200);
    expect(base.membership.count).not.toHaveBeenCalled();
  });
});
