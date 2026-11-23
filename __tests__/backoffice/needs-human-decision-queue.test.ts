/**
 * @jest-environment node
 */

/**
 * The decision queue is one paged, sorted read over the needs-human
 * predicate at the read's time: one list, one count and one batched user read, each row naming
 * its booking, expert and learner (or roster), with its age computed per row.
 */

import { NextRequest } from "next/server";

const mockFindMany = jest.fn();
const mockCount = jest.fn(async (_args: unknown) => 41);
const mockUsers = jest.fn(async (_args: unknown) => [
  { id: "u-expert", name: "Asha", email: "a@x.test", image: null },
  { id: "u-learner", name: null, email: "r@x.test", image: null },
]);

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    appointmentOccurrence: {
      findMany: (args: unknown) => mockFindMany(args),
      count: (args: unknown) => mockCount(args),
    },
    user: { findMany: (args: unknown) => mockUsers(args) },
  },
}));
// The overturn door in the same module takes the appointment lock; this suite never does.
jest.mock("../../utils/appointmentlock", () => ({
  withAppointmentLock: jest.fn(),
}));
jest.mock("../../lib/auth-helpers", () => ({
  requireBackofficeSurface: async () => ({
    session: { user: { id: "op-1", role: "STAFF" } },
  }),
}));

import { needsHumanWhere } from "../../lib/booking/misses";
import { readSessionsNeedingHuman } from "../../lib/backoffice/session-outcomes";
import {
  needsHumanQuerySchema,
  needsHumanQueueSearch,
} from "../../lib/backoffice/needs-human-queue";
import { GET } from "../../app/api/admin/sessions/needs-human/route";

const NOW = new Date("2026-11-17T12:00:00Z");

const noPlans = {
  consultation: null,
  subscription: null,
  trial: null,
  webinar: null,
  class: null,
};

/** Rows in the shape NEEDS_HUMAN_ROW_SELECT returns. */
const rows = [
  {
    id: "occ-old",
    appointmentId: "apt-1",
    startsAt: new Date("2026-11-01T10:00:00Z"),
    endsAt: new Date("2026-11-01T11:00:00Z"),
    outcomeAt: new Date("2026-11-01T12:00:00Z"),
    outcomeConfirmedAt: null,
    completionStatus: "UNVERIFIED",
    outcome: "INCONCLUSIVE",
    deliveredMinutes: 20,
    lostMinutes: 40,
    meeting: { endedReason: null },
    appointment: {
      ...noPlans,
      appointmentType: "CONSULTATION",
      deletedAt: null,
      _count: { participants: 1 },
      consultation: {
        id: "c1",
        status: "APPROVED",
        bookingSource: "DIRECT_CHECKOUT",
        consultationPlan: {
          id: "cp1",
          title: "Career chat",
          price: 50_000,
          priceCurrency: "INR",
          durationInHours: 1,
          consultantProfile: { userId: "u-expert" },
        },
        requestedBy: { userId: "u-learner" },
      },
    },
  },
  {
    id: "occ-new",
    appointmentId: "apt-2",
    startsAt: new Date("2026-11-15T10:00:00Z"),
    endsAt: new Date("2026-11-15T11:00:00Z"),
    outcomeAt: null,
    outcomeConfirmedAt: null,
    completionStatus: "UNVERIFIED",
    outcome: null,
    deliveredMinutes: null,
    lostMinutes: null,
    meeting: { endedReason: "maintenance" },
    appointment: {
      ...noPlans,
      appointmentType: "WEBINAR",
      deletedAt: null,
      _count: { participants: 3 },
      webinar: {
        id: "w1",
        status: "SCHEDULED",
        webinarPlan: {
          id: "wp1",
          title: "Live Q&A",
          price: 0,
          priceCurrency: "INR",
          maxParticipants: 50,
          consultantProfile: { userId: "u-expert" },
        },
      },
    },
  },
];

beforeEach(() => {
  jest.clearAllMocks();
  mockFindMany.mockResolvedValue(rows);
});

it("reads one page in three statements over the predicate at its time, oldest first", async () => {
  const page = await readSessionsNeedingHuman({ now: NOW });

  expect(mockFindMany).toHaveBeenCalledTimes(1);
  expect(mockCount).toHaveBeenCalledTimes(1);
  expect(mockUsers).toHaveBeenCalledTimes(1);
  const [list] = mockFindMany.mock.calls[0] as [Record<string, unknown>];
  expect(list).toMatchObject({
    relationLoadStrategy: "join",
    where: needsHumanWhere(NOW),
    orderBy: [{ endsAt: "asc" }, { id: "asc" }],
    skip: 0,
    take: 20,
  });
  expect(mockCount.mock.calls[0][0]).toEqual({
    where: needsHumanWhere(NOW),
  });
  expect(page).toMatchObject({ total: 41, page: 1, pageSize: 20 });
});

it("cuts the second page at the boundary and sorts a nullable column with nulls last", async () => {
  await readSessionsNeedingHuman({
    page: 2,
    sort: { key: "lostMinutes", dir: "desc" },
    now: NOW,
  });
  expect(mockFindMany.mock.calls[0][0]).toMatchObject({
    orderBy: [{ lostMinutes: { sort: "desc", nulls: "last" } }, { id: "asc" }],
    skip: 20,
    take: 20,
  });
});

it("names each row's booking, expert and learner, or the roster of an event", async () => {
  const { items } = await readSessionsNeedingHuman({ now: NOW });
  expect(items[0]).toMatchObject({
    id: "occ-old",
    appointmentId: "apt-1",
    aged: true,
    booking: {
      type: "CONSULTATION",
      title: "Career chat",
      expert: { id: "u-expert", name: "Asha", email: "a@x.test" },
      learner: { id: "u-learner", name: null, email: "r@x.test" },
      attendeeLabel: null,
      removed: false,
    },
  });
  expect(items[1]).toMatchObject({
    aged: false,
    endedReason: "maintenance",
    booking: {
      type: "WEBINAR",
      title: "Live Q&A",
      learner: null,
      attendeeLabel: "3 attendees",
    },
  });
  expect(mockUsers.mock.calls[0][0]).toMatchObject({
    where: { id: { in: ["u-expert", "u-learner"] } },
  });
});

it("whitelists ?sort and ?page", () => {
  expect(needsHumanQuerySchema.parse({})).toEqual({
    page: 1,
    sort: { key: "endsAt", dir: "asc" },
  });
  expect(
    needsHumanQuerySchema.parse({ page: "3", sort: "-outcomeAt" }),
  ).toEqual({ page: 3, sort: { key: "outcomeAt", dir: "desc" } });
  for (const bad of [
    { sort: "createdAt" },
    { sort: "-id" },
    { page: "0" },
    { page: "1.5" },
    { page: "abc" },
  ]) {
    expect(needsHumanQuerySchema.safeParse(bad).success).toBe(false);
  }
});

it("the card's query string parses back to the page and sort it asked for", () => {
  const sort = { key: "lostMinutes", dir: "desc" } as const;
  const sent = Object.fromEntries(
    new URLSearchParams(needsHumanQueueSearch(2, sort)),
  );
  expect(needsHumanQuerySchema.parse(sent)).toEqual({ page: 2, sort });
});

it("the route refuses an unknown sort with 400 and reads a valid one", async () => {
  const bad = await GET(
    new NextRequest("http://test/api/admin/sessions/needs-human?sort=id"),
  );
  expect(bad.status).toBe(400);
  expect(mockFindMany).not.toHaveBeenCalled();

  const ok = await GET(
    new NextRequest(
      "http://test/api/admin/sessions/needs-human?page=2&sort=-startsAt",
    ),
  );
  expect(ok.status).toBe(200);
  expect(mockFindMany.mock.calls[0][0]).toMatchObject({
    orderBy: [{ startsAt: "desc" }, { id: "asc" }],
    skip: 20,
  });
  const body = (await ok.json()) as { items: unknown[]; total: number };
  expect(body.items).toHaveLength(2);
  expect(body.total).toBe(41);
});

it("offers Confirm only on an applied negative verdict nobody confirmed", async () => {
  const closed = {
    ...rows[0],
    completionStatus: "COMPLETED",
    outcome: "LEARNER_ABSENT",
  };
  mockFindMany.mockResolvedValue([
    closed,
    { ...closed, id: "occ-done", outcomeConfirmedAt: NOW },
    {
      ...closed,
      id: "occ-parked",
      completionStatus: "UNVERIFIED",
      outcome: "HOST_ABSENT",
    },
    rows[0],
  ]);
  const { items } = await readSessionsNeedingHuman({ now: NOW });
  expect(items.map((i) => i.canConfirm)).toEqual([true, false, false, false]);
});
