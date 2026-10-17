/**
 * @jest-environment node
 */

// Invariant: an event PUT never writes status CANCELLED; cancellation goes through the cancel route (409 USE_CANCEL_ROUTE).

const webinarFindUnique = jest.fn();
const webinarUpdate = jest.fn();
const classFindUnique = jest.fn();
const classUpdate = jest.fn();

jest.mock("../../../lib/prisma", () => ({
  __esModule: true,
  default: {
    webinar: {
      findUnique: (...a: unknown[]) => webinarFindUnique(...a),
      update: (...a: unknown[]) => webinarUpdate(...a),
    },
    class: {
      findUnique: (...a: unknown[]) => classFindUnique(...a),
      update: (...a: unknown[]) => classUpdate(...a),
    },
  },
}));
jest.mock("../../../lib/auth-helpers", () => ({
  __esModule: true,
  requireApiAuth: async () => ({
    session: {
      user: { id: "u-owner", role: "CONSULTANT", consultantProfileId: "cp-1" },
    },
  }),
  isPrivileged: (role: string) => role === "ADMIN" || role === "STAFF",
  authorizeEventAccess: async () => null,
}));

import { NextRequest } from "next/server";
import { PUT as webinarPut } from "../../../app/api/bookings/webinars/[webinarId]/route";
import { PUT as classPut } from "../../../app/api/bookings/classes/[classId]/route";

const put = (body: unknown) =>
  new NextRequest("http://localhost/x", {
    method: "PUT",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });

beforeEach(() => {
  jest.clearAllMocks();
  webinarFindUnique.mockResolvedValue({ status: "SCHEDULED" });
  classFindUnique.mockResolvedValue({ status: "SCHEDULED" });
  webinarUpdate.mockResolvedValue({ id: "w1", status: "CANCELLED" });
  classUpdate.mockResolvedValue({ id: "c1", status: "CANCELLED" });
});

describe("event PUT refuses a status write", () => {
  it("webinar: PUT {status:CANCELLED} -> 409 USE_CANCEL_ROUTE, no status write", async () => {
    const res = await webinarPut(put({ status: "CANCELLED" }), {
      params: Promise.resolve({ webinarId: "w1" }),
    });
    const statusWrites = webinarUpdate.mock.calls.filter(
      ([arg]) => (arg as { data: { status?: string } }).data.status,
    );
    expect(statusWrites).toHaveLength(0);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "USE_CANCEL_ROUTE" });
  });

  it("class: PUT {status:CANCELLED} -> 409 USE_CANCEL_ROUTE, no status write", async () => {
    const res = await classPut(put({ status: "CANCELLED" }), {
      params: Promise.resolve({ classId: "c1" }),
    });
    const statusWrites = classUpdate.mock.calls.filter(
      ([arg]) => (arg as { data: { status?: string } }).data.status,
    );
    expect(statusWrites).toHaveLength(0);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "USE_CANCEL_ROUTE" });
  });
});
