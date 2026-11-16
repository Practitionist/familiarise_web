/**
 * @jest-environment node
 */

/**
 * Trials in the operator Appointments reader: every tab and the search have a
 * trial arm, a trial priced at request is not free, and a removed booking is
 * listed as removed rather than hidden.
 */

import { AppointmentsType } from "@prisma/client";

const mockCount = jest.fn(async (_args: unknown) => 1);
const mockFindMany = jest.fn(async (_args: unknown): Promise<unknown[]> => []);

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    appointment: {
      findMany: (args: unknown) => mockFindMany(args),
      count: (args: unknown) => mockCount(args),
    },
    user: {
      findMany: async () => [
        { id: "u-expert", name: "Asha", email: "a@x.test", image: null },
        { id: "u-learner", name: "Ravi", email: "r@x.test", image: null },
        { id: "u-host", name: "Bela", email: "b@x.test", image: null },
      ],
    },
  },
}));

jest.mock("../../lib/auth-helpers", () => ({
  requireBackofficeSurface: async () => ({
    session: { user: { id: "op-1", role: "STAFF" } },
  }),
}));

import { NextRequest } from "next/server";
import { GET } from "../../app/api/staff/appointments/route";
import {
  staffAppointmentSchema,
  staffAppointmentsPayloadSchema,
} from "../../lib/data/staff-appointments-schema";
import {
  buildStatusWhere,
  getStaffAppointments,
} from "../../lib/data/staff-appointments";
import {
  staffStatus,
  TYPE_OPTIONS,
} from "../../components/dashboard/shared/OperatorAppointmentsClient";

const base = {
  createdAt: new Date("2026-11-11T17:19:08Z"),
  rescheduleRequests: [],
  _count: { participants: 0 },
  consultation: null,
  subscription: null,
  webinar: null,
  class: null,
};

/** A paid trial priced at request; the plan has since gone free. Asha wrote the plan, Bela hosts the trial. */
const pricedTrial = {
  ...base,
  id: "apt-trial",
  appointmentType: "TRIAL",
  deletedAt: null,
  occurrences: [],
  payment: [],
  trial: {
    status: "AWAITING_PAYMENT",
    agreedPricePaise: 17_800,
    subscriptionPlan: {
      title: "Guitar basics",
      trialPriceInPaise: 0,
      trialDurationMinutes: 30,
      consultantProfile: { userId: "u-expert" },
    },
    consultantProfile: { userId: "u-host" },
    consulteeProfile: { userId: "u-learner" },
  },
};

/** The reported row: a soft-deleted trial wrapper whose trial row is gone. */
const removedWrapper = {
  ...base,
  id: "3b0a1b7c-42cd-465e-8b4d-8dccba7f8820",
  appointmentType: "TRIAL",
  deletedAt: new Date("2026-11-11T17:19:28Z"),
  occurrences: [
    {
      id: "o1",
      startsAt: new Date("2026-11-12T12:00:00Z"),
      endsAt: new Date("2026-11-12T12:30:00Z"),
      isTentative: true,
    },
  ],
  payment: [
    {
      id: "p1",
      amount: 17_800,
      currency: "INR",
      paymentStatus: "EXPIRED",
      paymentGateway: "RAZORPAY",
      expiresAt: null,
      createdAt: new Date("2026-11-11T17:19:08Z"),
    },
  ],
  trial: null,
};

beforeEach(() => jest.clearAllMocks());

it("gives every tab a trial arm", () => {
  expect(buildStatusWhere("scheduled")?.OR).toContainEqual({
    trial: { status: "SCHEDULED" },
  });
  expect(buildStatusWhere("completed")?.OR).toContainEqual({
    trial: { status: { in: ["COMPLETED", "CONVERTED"] } },
  });
  const issue = buildStatusWhere("issue")?.OR ?? [];
  expect(issue).toContainEqual({ trial: { status: "CANCELLED" } });
  expect(issue).toContainEqual({
    appointmentType: "TRIAL",
    trial: { is: null },
  });
  expect(issue).toContainEqual({ deletedAt: { not: null } });
});

it("searches a trial's plan, expert and learner", async () => {
  await getStaffAppointments({ scope: { kind: "all" }, search: "ravi" });
  const where = (mockCount.mock.calls[1][0] as { where: { OR: unknown[] } })
    .where;
  const people = {
    OR: [
      { name: { contains: "ravi", mode: "insensitive" } },
      { email: { contains: "ravi", mode: "insensitive" } },
    ],
  };
  expect(where.OR).toEqual(
    expect.arrayContaining([
      {
        trial: {
          subscriptionPlan: {
            title: { contains: "ravi", mode: "insensitive" },
          },
        },
      },
      { trial: { consultantProfile: { user: people } } },
      { trial: { consulteeProfile: { user: people } } },
    ]),
  );
  // The plan's author is not the trial's expert.
  expect(JSON.stringify(where.OR)).not.toContain(
    '"subscriptionPlan":{"consultantProfile"',
  );
});

it("filters by the Trial type the picker sends", async () => {
  const trial = TYPE_OPTIONS.find((o) => o.label === "Trial");
  expect(trial?.value).toBe("trial");
  const sent = trial!.value.toUpperCase();
  expect(Object.values(AppointmentsType)).toContain(sent);
  await getStaffAppointments({ scope: { kind: "all" }, type: sent });
  expect(mockCount.mock.calls[1][0]).toEqual({
    where: { appointmentType: "TRIAL" },
  });
});

it("prices a trial from what the buyer agreed to, not the plan's later price", async () => {
  mockFindMany.mockResolvedValueOnce([pricedTrial]);
  const { appointments } = await getStaffAppointments({
    scope: { kind: "all" },
  });
  expect(appointments[0]).toMatchObject({
    title: "Guitar basics",
    free: false,
    removed: false,
    duration: 30,
    // The trial's own consultant hosts it, whoever wrote the plan.
    consultant: { name: "Bela" },
    consultee: { name: "Ravi" },
  });
  expect(staffStatus(appointments[0]).label).toBe("Awaiting payment");
});

it("lists the reported removed trial as removed and cancelled, never scheduled", async () => {
  mockFindMany.mockResolvedValueOnce([removedWrapper]);
  const { appointments } = await getStaffAppointments({
    scope: { kind: "all" },
  });
  const row = appointments[0];
  expect(row).toMatchObject({
    title: "Trial (record removed)",
    removed: true,
    hasIssue: true,
    issueType: "Removed",
  });
  expect(staffStatus(row).label).toBe("Cancelled");
});

it("clamps the route's page size to 100 and falls back on junk", async () => {
  for (const [raw, take] of [
    ["900", 100],
    ["50", 50],
    ["abc", 20],
    ["0", 20],
  ] as const) {
    mockFindMany.mockClear();
    const res = await GET(
      new NextRequest(`http://test/api/staff/appointments?limit=${raw}`),
    );
    expect(res.status).toBe(200);
    expect(mockFindMany.mock.calls[0][0]).toMatchObject({ take });
  }
});

it("the reader's own payload parses, and a misspelt enum does not", async () => {
  mockFindMany.mockResolvedValueOnce([pricedTrial, removedWrapper]);
  const payload = await getStaffAppointments({ scope: { kind: "all" } });
  expect(staffAppointmentsPayloadSchema.safeParse(payload).success).toBe(true);

  const row = payload.appointments[1];
  for (const bad of [
    { bookingSource: "DIRECT_CHEKOUT" },
    { type: "TRIAL" },
    { status: "scheduledd" },
    { issueType: "Broken" },
    { payment: { ...row.payment, gateway: "PAYPAL" } },
  ]) {
    expect(staffAppointmentSchema.safeParse({ ...row, ...bad }).success).toBe(
      false,
    );
  }
});
