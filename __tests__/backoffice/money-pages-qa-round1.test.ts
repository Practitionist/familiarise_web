/**
 * @jest-environment node
 */

/**
 * QA round 1 on the money pages: earnings page without repeats when rows tie
 * on their creation time, an unknown status filter is a 400 on every money
 * list, the old detail-page parents redirect to the money tabs, and console
 * targets name organisations and leads within four batched reads.
 */

import { NextRequest } from "next/server";

jest.mock("@sentry/nextjs", () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));
jest.mock("../../lib/auth-helpers", () => ({
  requireBackofficeSurface: async () => ({
    session: { user: { id: "admin-1", role: "ADMIN" } },
  }),
}));
const mockRedirect = jest.fn((url: string) => {
  throw new Error(`redirect ${url}`);
});
jest.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("notFound");
  },
  permanentRedirect: (url: string) => mockRedirect(url),
}));

/** 160 earnings, four to each of 40 creation instants. */
const mockEarnings = Array.from({ length: 160 }, (_, i) => ({
  id: `earn-${String(i).padStart(3, "0")}`,
  paymentId: "pay-1",
  consultantProfileId: "cp-1",
  consultantSharePaise: 10_000,
  status: "PENDING",
  holdUntil: null,
  createdAt: new Date(Date.UTC(2026, 10, 1, 0, Math.floor(i / 4))),
  consultantProfile: {
    userId: "user-2",
    user: { name: "Aarav Anderson", email: "aarav@example.test" },
  },
  payment: {
    id: "pay-1",
    user: { id: "user-1", name: "Priya Anderson", email: "p@example.test" },
    appointment: null,
  },
}));

type Order = Record<string, unknown>[];
/** Postgres keeps no promise about the order of tied rows: shuffle each tie unless an id key breaks it. */
function mockPage<T extends { id: string; createdAt: Date }>(
  rows: T[],
  args: { orderBy: Order; skip: number; take: number },
) {
  const byId = args.orderBy.some((o) => "id" in o);
  const shuffled = [...rows].sort(() => Math.random() - 0.5);
  const sorted = shuffled.sort(
    (a, b) =>
      b.createdAt.getTime() - a.createdAt.getTime() ||
      (byId ? (a.id < b.id ? 1 : -1) : 0),
  );
  return sorted.slice(args.skip, args.skip + args.take);
}

const mockReads: Record<string, unknown[]> = {};
function mockRead(model: string, rows: () => unknown[]) {
  return async (args: unknown) => {
    mockReads[model] = [...(mockReads[model] ?? []), args];
    return rows();
  };
}

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    consultantEarnings: {
      findMany: async (args: { orderBy: Order; skip: number; take: number }) =>
        mockPage(mockEarnings, args),
      count: async () => mockEarnings.length,
    },
    subscription: { findMany: async () => [] },
    payment: {
      findMany: mockRead("payment", () => []),
      count: async () => 0,
    },
    consumerInvoice: {
      findMany: async () => [],
      count: async () => 0,
      aggregate: async () => ({ _sum: {} }),
    },
    organizationInvoice: {
      findMany: async () => [],
      count: async () => 0,
      groupBy: async () => [],
    },
    user: {
      findMany: mockRead("user", () => [
        {
          id: "user-1",
          name: "Priya Anderson",
          email: "p@example.test",
          Payment: [{ id: "pay-1", appointment: null }],
        },
      ]),
    },
    appointment: { findMany: mockRead("appointment", () => []) },
    organization: {
      findMany: mockRead("organization", () => [
        { id: "org-1", name: "Wipro" },
      ]),
    },
    lead: {
      findMany: mockRead("lead", () => [
        {
          id: "lead-1",
          contactName: "Meera Iyer",
          contactEmail: "meera@example.test",
          companyName: "Acme",
        },
      ]),
    },
  },
}));

import { GET as earningsGet } from "../../app/api/admin/earnings/route";
import { GET as subscriptionsGet } from "../../app/api/admin/subscriptions/route";
import { GET as invoicesGet } from "../../app/api/admin/invoices/route";
import PaymentsParent from "../../app/dashboard/(backoffice)/[tree]/payments/page";
import DisputesParent from "../../app/dashboard/(backoffice)/[tree]/disputes/page";
import { resolveTargets, targetKey } from "../../lib/backoffice/target-refs";

const get = (route: (r: NextRequest) => Promise<Response>, path: string) =>
  route(new NextRequest(`http://test${path}`));

it("pages 160 earnings that share 40 creation times without a repeat or a gap", async () => {
  const seen: string[] = [];
  for (let offset = 0; offset < 160; offset += 20) {
    const body = await (
      await get(earningsGet, `/api/admin/earnings?limit=20&offset=${offset}`)
    ).json();
    seen.push(...body.earnings.map((e: { id: string }) => e.id));
  }
  expect(seen).toHaveLength(160);
  expect(new Set(seen).size).toBe(160);
});

describe("an unknown status filter is a 400", () => {
  it.each([
    ["earnings", earningsGet, "/api/admin/earnings?status=BOGUS"],
    [
      "subscriptions",
      subscriptionsGet,
      "/api/admin/subscriptions?status=BOGUS",
    ],
    ["org invoices", invoicesGet, "/api/admin/invoices?status=BOGUS"],
    [
      "consumer invoices",
      invoicesGet,
      "/api/admin/invoices?scope=b2c&status=PAID",
    ],
  ])("%s", async (_name, route, path) => {
    expect((await get(route, path)).status).toBe(400);
  });

  it.each([
    ["earnings", earningsGet, "/api/admin/earnings?status=HELD"],
    [
      "subscriptions",
      subscriptionsGet,
      "/api/admin/subscriptions?status=expired",
    ],
    ["org invoices", invoicesGet, "/api/admin/invoices?status=OVERDUE"],
    [
      "org invoices, every status",
      invoicesGet,
      "/api/admin/invoices?status=ALL",
    ],
    [
      "consumer invoices",
      invoicesGet,
      "/api/admin/invoices?scope=b2c&status=CREDIT_NOTED",
    ],
  ])("a known one still reads, %s", async (_name, route, path) => {
    expect((await get(route, path)).status).toBe(200);
  });
});

it.each([
  [PaymentsParent, "/dashboard/staff/money/payments"],
  [DisputesParent, "/dashboard/staff/money/disputes"],
])("a detail page's parent crumb lands on its money tab", async (Page, to) => {
  await expect(
    Page({ params: Promise.resolve({ tree: "staff" }) }),
  ).rejects.toThrow(`redirect ${to}`);
});

it("names organisation and lead targets, with at most four reads a page", async () => {
  for (const key of Object.keys(mockReads)) delete mockReads[key];
  const refs = await resolveTargets([
    { kind: "User", id: "user-1" },
    { kind: "Payment", id: "pay-1" },
    { kind: "Appointment", id: "appt-1" },
    { kind: "AppointmentOccurrence", id: "occ-1" },
    { kind: "Organization", id: "org-1" },
    { kind: "Lead", id: "lead-1" },
  ]);
  const reads = Object.values(mockReads).reduce((n, c) => n + c.length, 0);
  expect(reads).toBeLessThanOrEqual(4);
  expect(refs.get(targetKey("Organization", "org-1"))?.person).toMatchObject({
    name: "Wipro",
  });
  expect(refs.get(targetKey("Lead", "lead-1"))?.person).toMatchObject({
    name: "Meera Iyer (Acme)",
    email: "meera@example.test",
  });
  expect(refs.get(targetKey("User", "user-1"))?.person?.name).toBe(
    "Priya Anderson",
  );
  expect(refs.get(targetKey("Payment", "pay-1"))?.person?.name).toBe(
    "Priya Anderson",
  );
});
