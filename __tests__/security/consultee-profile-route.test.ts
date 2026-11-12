/**
 * @jest-environment node
 */

/**
 * The learner profile is deleted only by its owner and only with nothing live
 * or paid behind it; an edit that omits a list leaves the stored list alone.
 */
const caller = { id: "u-buyer", role: "USER", consulteeProfileId: "cee-1" };
jest.mock("../../lib/prisma", () => {
  const count = () => ({ count: jest.fn(async () => 0) });
  return {
    __esModule: true,
    default: {
      consulteeProfile: {
        findUnique: jest.fn(),
        update: jest.fn(async () => ({ id: "cee-1" })),
        delete: jest.fn(),
      },
      consultation: count(),
      subscription: count(),
      trial: count(),
      rescheduleRequest: count(),
      appointmentParticipant: count(),
      payment: count(),
    },
  };
});
jest.mock("../../lib/auth-helpers", () => ({
  ...jest.requireActual("../../lib/auth-helpers"),
  requireApiAuth: async () => ({ session: { user: caller } }),
}));
jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));

import { NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import { DELETE, PATCH } from "@/app/api/user/consultees/[id]/route";

const db = prisma as unknown as {
  consulteeProfile: Record<"findUnique" | "update" | "delete", jest.Mock>;
  consultation: { count: jest.Mock };
};

const params = { params: Promise.resolve({ id: "cee-1" }) };
const call = (method: string, body?: unknown) =>
  new NextRequest("http://localhost/api/user/consultees/cee-1", {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

beforeEach(() => {
  jest.clearAllMocks();
  Object.assign(caller, { id: "u-buyer", role: "USER" });
  db.consulteeProfile.findUnique.mockResolvedValue({
    id: "cee-1",
    userId: "u-buyer",
  });
});

it("refuses STAFF: only the owner deletes a learner profile", async () => {
  Object.assign(caller, { id: "u-staff", role: "STAFF" });
  const res = await DELETE(call("DELETE"), params);
  expect(res.status).toBe(403);
  expect(db.consulteeProfile.delete).not.toHaveBeenCalled();
});

it("refuses the owner while a booking is still live", async () => {
  db.consultation.count.mockResolvedValueOnce(1);
  const res = await DELETE(call("DELETE"), params);
  expect(res.status).toBe(400);
  expect(await res.json()).toMatchObject({
    code: "ACTIVE_APPOINTMENTS_BLOCK_DELETE",
  });
  expect(db.consulteeProfile.delete).not.toHaveBeenCalled();
});

it("an edit that omits skillsToDevelop leaves the stored list untouched", async () => {
  await PATCH(call("PATCH", { aboutMe: "Hello" }), params);
  const { data } = (
    db.consulteeProfile.update.mock.calls as unknown as Array<
      [{ data: Record<string, unknown> }]
    >
  )[0][0];
  expect(data.skillsToDevelop).toBeUndefined();
  expect(data.aboutMe).toBe("Hello");
});
