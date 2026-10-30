/**
 * @jest-environment node
 */

/**
 * The plan editors' duplicate-title probe is signed-in only and answers only
 * about the caller's own plans; staff may ask about anyone's.
 */

const auth: {
  session: {
    user: { id: string; role: string; consultantProfileId: string | null };
  } | null;
} = { session: null };
jest.mock("@/lib/auth-helpers", () => ({
  requireApiAuth: jest.fn(async () =>
    auth.session
      ? { session: auth.session }
      : {
          error: new Response(JSON.stringify({ error: "Unauthorized" }), {
            status: 401,
          }),
        },
  ),
  isPrivileged: (role: string) => role === "ADMIN" || role === "STAFF",
}));
const findFirst = jest.fn(async () => ({ id: "plan-1" }));
jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  default: {
    consultationPlan: {
      findFirst: (...a: unknown[]) => findFirst(...(a as [])),
    },
    subscriptionPlan: {
      findFirst: (...a: unknown[]) => findFirst(...(a as [])),
    },
    webinarPlan: { findFirst: (...a: unknown[]) => findFirst(...(a as [])) },
    classPlan: { findFirst: (...a: unknown[]) => findFirst(...(a as [])) },
  },
}));

import { NextRequest } from "next/server";
import { GET as consultations } from "@/app/api/bookings/consultations/check-duplicate-title/route";
import { GET as subscriptions } from "@/app/api/bookings/subscriptions/check-duplicate-title/route";
import { GET as webinars } from "@/app/api/bookings/webinars/check-duplicate-title/route";
import { GET as classes } from "@/app/api/bookings/classes/check-duplicate-title/route";

const req = (consultantProfileId: string) =>
  new NextRequest(
    `http://localhost/x?title=Intro&consultantProfileId=${consultantProfileId}`,
  );

const ROUTES = { consultations, subscriptions, webinars, classes };

beforeEach(() => {
  jest.clearAllMocks();
  auth.session = {
    user: { id: "u-1", role: "CONSULTANT", consultantProfileId: "cp-own" },
  };
});

describe.each(Object.entries(ROUTES))("%s check-duplicate-title", (_n, GET) => {
  it("401s without a session and reads nothing", async () => {
    auth.session = null;
    expect((await GET(req("cp-own"))).status).toBe(401);
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("403s when probing another consultant's plans", async () => {
    const res = await GET(req("cp-someone-else"));
    expect(res.status).toBe(403);
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("answers for the caller's own plans, case-insensitively", async () => {
    const res = await GET(req("cp-own"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ isDuplicate: true });
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          consultantProfileId: "cp-own",
          title: { equals: "Intro", mode: "insensitive" },
        }),
      }),
    );
  });

  it("lets staff check any consultant", async () => {
    auth.session = {
      user: { id: "u-staff", role: "STAFF", consultantProfileId: null },
    };
    expect((await GET(req("cp-someone-else"))).status).toBe(200);
  });
});
