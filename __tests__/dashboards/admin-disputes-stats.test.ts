/**
 * @jest-environment node
 */

/**
 * #997 secondary findings — the Disputes dashboard's "Under Review"/"Won"
 * stat cards used to `.filter()` the current *page* of disputes (≤20 rows)
 * instead of counting the whole table, so they silently undercounted at
 * scale. Pins that the route now returns a server-computed `stats` block
 * that ignores the current page/search/gateway filter, mirroring how
 * `urgentDisputes` was already computed.
 */

import { NextRequest } from "next/server";
import { GET } from "../../app/api/admin/disputes/route";
import { requireBackofficeSurface } from "@/lib/auth-helpers";
import prisma from "@/lib/prisma";

jest.mock("../../lib/auth-helpers", () => ({
  __esModule: true,
  requireBackofficeSurface: jest.fn(),
}));
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    dispute: {
      findMany: jest.fn(),
      count: jest.fn(),
    },
  },
}));

const mockedAuth = requireBackofficeSurface as jest.Mock;
const mockedFindMany = prisma.dispute.findMany as jest.Mock;
const mockedCount = prisma.dispute.count as jest.Mock;

function req(url: string) {
  return new NextRequest(url);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedAuth.mockResolvedValue({
    session: { user: { id: "staff-1", role: "STAFF" } },
  });
  mockedFindMany.mockResolvedValue([]);
});

describe("GET /api/admin/disputes — stats", () => {
  it("returns dashboard-wide underReviewCount/wonCount independent of the page size", async () => {
    // Page 1 of a filtered search only returns 2 rows, but the platform
    // has far more UNDER_REVIEW/WON disputes overall.
    mockedCount.mockImplementation(async ({ where }) => {
      if (where?.status === "UNDER_REVIEW") return 37;
      if (where?.status === "WON") return 112;
      return 2;
    });

    const res = await GET(
      req("http://localhost/api/admin/disputes?search=acme&limit=20"),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.stats).toEqual({ underReviewCount: 37, wonCount: 112 });
  });

  it("computes underReviewCount/wonCount with a status-only where (no search/gateway leakage)", async () => {
    mockedCount.mockResolvedValue(0);

    await GET(
      req("http://localhost/api/admin/disputes?search=acme&gateway=STRIPE"),
    );

    const wheres = mockedCount.mock.calls.map(([args]) => args);
    expect(wheres).toContainEqual({ where: { status: "UNDER_REVIEW" } });
    expect(wheres).toContainEqual({ where: { status: "WON" } });
  });

  it("splits the urgent disputes by whether the evidence door takes them", async () => {
    mockedCount.mockResolvedValue(0);
    const day = 24 * 60 * 60 * 1000;
    const urgent = [
      // Razorpay, open, due in two days: the door takes evidence.
      {
        status: "NEEDS_RESPONSE",
        paymentGateway: "RAZORPAY",
        dueBy: new Date(Date.now() + 2 * day),
      },
      // Razorpay, open, a day overdue: the door answers 410.
      {
        status: "NEEDS_RESPONSE",
        paymentGateway: "RAZORPAY",
        dueBy: new Date(Date.now() - day),
      },
      // A Razorpay warning: the door takes evidence only on an open dispute.
      {
        status: "WARNING_NEEDS_RESPONSE",
        paymentGateway: "RAZORPAY",
        dueBy: new Date(Date.now() + day),
      },
      // Stripe: this door contests Razorpay disputes only.
      {
        status: "NEEDS_RESPONSE",
        paymentGateway: "STRIPE",
        dueBy: new Date(Date.now() + day),
      },
    ];
    mockedFindMany.mockImplementation(async ({ where }) =>
      where?.dueBy ? urgent : [],
    );

    const body = await (
      await GET(req("http://localhost/api/admin/disputes"))
    ).json();
    expect(body.urgentDisputes).toBe(4);
    expect(body.urgentEvidence).toEqual({
      open: 1,
      deadlinePassed: 1,
      notOpen: 1,
      otherGateway: 1,
    });
  });

  it("403s when the caller isn't privileged", async () => {
    mockedAuth.mockResolvedValue({
      error: new Response(JSON.stringify({ error: "Forbidden" }), {
        status: 403,
      }),
    });
    const res = await GET(req("http://localhost/api/admin/disputes"));
    expect(res.status).toBe(403);
    expect(mockedFindMany).not.toHaveBeenCalled();
  });
});
