/**
 * @jest-environment node
 */

// POST /api/meetings/[id]/host-live: only the plan's host announces, once per session.

const guardMeetingRoute = jest.fn();
jest.mock("../../lib/meetings/route-guard", () => ({
  guardMeetingRoute: (...a: unknown[]) => guardMeetingRoute(...a),
}));
const stageHostLiveBell = jest.fn();
jest.mock("../../lib/meetings/host-live", () => ({
  stageHostLiveBell: (...a: unknown[]) => stageHostLiveBell(...a),
}));
const flushNotificationsAfter = jest.fn(async () => undefined);
jest.mock("../../lib/novu/stage-then-attempt", () => ({
  flushNotificationsAfter: (...a: unknown[]) =>
    flushNotificationsAfter(...(a as [])),
}));
jest.mock("../../lib/rate-limit", () => ({
  meetingJoinLimiter: { name: "meetingJoinLimiter" },
}));
jest.mock("../../lib/stream-logger", () => ({
  streamLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock("../../lib/observability/report", () => ({
  reportSentryError: jest.fn(),
}));

import { NextRequest } from "next/server";
import { POST } from "../../app/api/meetings/[meetingId]/host-live/route";
import { meetingJoinLimiter } from "../../lib/rate-limit";

const ping = () =>
  POST(new NextRequest("https://x.test/api/meetings/c1/host-live"), {
    params: Promise.resolve({ meetingId: "c1" }),
  });

function grant(role: "host" | "participant", coPresenter = false) {
  guardMeetingRoute.mockResolvedValue({
    ok: true,
    userId: "u-1",
    meetingId: "c1",
    access: {
      role,
      ...(coPresenter ? { coPresenter } : {}),
      streamCallId: "c1",
      occurrence: { id: "occ-1" },
    },
  });
}

beforeEach(() => jest.clearAllMocks());

it.each([
  ["an attendee", "participant" as const, false],
  ["a co-presenter", "host" as const, true],
])("refuses %s and stages nothing", async (_who, role, coPresenter) => {
  grant(role, coPresenter);
  const res = await ping();
  expect(res.status).toBe(403);
  expect(stageHostLiveBell).not.toHaveBeenCalled();
});

it("announces on the host's first ping and is a no-op on the next", async () => {
  grant("host");
  stageHostLiveBell.mockResolvedValueOnce([{ id: "p1" }, { id: "p2" }]);
  const first = await ping();
  expect(first.status).toBe(200);
  expect(await first.json()).toEqual({ announced: true });
  expect(guardMeetingRoute.mock.calls[0][2]).toBe(meetingJoinLimiter);
  expect(stageHostLiveBell).toHaveBeenCalledWith("occ-1");
  expect(flushNotificationsAfter).toHaveBeenCalledWith(
    { bells: [{ id: "p1" }, { id: "p2" }] },
    "meetings.hostLive",
  );

  stageHostLiveBell.mockResolvedValueOnce([]);
  const second = await ping();
  expect(second.status).toBe(200);
  expect(await second.json()).toEqual({ announced: false });
});
