/** @jest-environment node */

// The back-office list of collaborations reads a page of rows, newest change
// first, and names the plan, the expert and whoever ended each one.

const mockFindMany = jest.fn();
const mockCount = jest.fn();
jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  default: {
    collaborator: {
      findMany: (...args: unknown[]) => mockFindMany(...args),
      count: (...args: unknown[]) => mockCount(...args),
    },
  },
}));

import {
  COLLABORATIONS_PAGE_SIZE,
  readCollaborations,
} from "@/lib/backoffice/collaborations-read";

const ACCEPTED_AT = new Date("2026-11-01T10:00:00Z");
const ENDED_AT = new Date("2026-11-09T10:00:00Z");
const expert = { id: "u-ravi", name: "Ravi", email: "ravi@example.com" };
const admin = { id: "u-asha", name: "Asha", email: "asha@example.com" };

it("reads one page in a stable order and maps each row for the table", async () => {
  mockCount.mockResolvedValue(120);
  mockFindMany.mockResolvedValue([
    {
      id: "c-1",
      role: "CO_HOST",
      revenueShareBps: 2500,
      status: "REMOVED",
      acceptedAt: ACCEPTED_AT,
      endedAt: ENDED_AT,
      webinarPlanId: "wp-1",
      classPlanId: null,
      consultantProfileId: "cp-ravi",
      webinarPlan: { title: "Systems", organization: { name: "Academy" } },
      classPlan: null,
      consultantProfile: { user: expert },
      endedBy: admin,
    },
    {
      id: "c-2",
      role: "TEACHING_ASSISTANT",
      revenueShareBps: 1000,
      status: "PENDING",
      acceptedAt: null,
      endedAt: null,
      webinarPlanId: null,
      classPlanId: "cl-1",
      consultantProfileId: "cp-ravi",
      webinarPlan: null,
      classPlan: { title: "Algebra", organization: null },
      consultantProfile: { user: expert },
      endedBy: null,
    },
  ]);

  const result = await readCollaborations({ page: 3 });

  expect(mockFindMany).toHaveBeenCalledWith(
    expect.objectContaining({
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      skip: 2 * COLLABORATIONS_PAGE_SIZE,
      take: COLLABORATIONS_PAGE_SIZE,
    }),
  );
  expect(result).toMatchObject({ total: 120, page: 3 });
  expect(result.rows).toEqual([
    {
      id: "c-1",
      planType: "webinar",
      planId: "wp-1",
      planTitle: "Systems",
      organizationName: "Academy",
      expert,
      consultantProfileId: "cp-ravi",
      roleLabel: "Co-host",
      sharePercent: 25,
      status: "REMOVED",
      acceptedAt: ACCEPTED_AT,
      endedAt: ENDED_AT,
      endedBy: admin,
    },
    {
      id: "c-2",
      planType: "class",
      planId: "cl-1",
      planTitle: "Algebra",
      organizationName: null,
      expert,
      consultantProfileId: "cp-ravi",
      roleLabel: "Teaching assistant",
      sharePercent: 10,
      status: "PENDING",
      acceptedAt: null,
      endedAt: null,
      endedBy: null,
    },
  ]);
});

it("selects no field beyond what the table shows", async () => {
  mockCount.mockResolvedValue(0);
  mockFindMany.mockResolvedValue([]);
  await readCollaborations({ page: 1 });
  const [{ select }] = mockFindMany.mock.calls[0] as [
    { select: Record<string, unknown> },
  ];
  expect(Object.keys(select).sort()).toEqual([
    "acceptedAt",
    "classPlan",
    "classPlanId",
    "consultantProfile",
    "consultantProfileId",
    "endedAt",
    "endedBy",
    "id",
    "revenueShareBps",
    "role",
    "status",
    "webinarPlan",
    "webinarPlanId",
  ]);
});
