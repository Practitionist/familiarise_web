/**
 * @jest-environment node
 */

/**
 * The offering editor reads the plan through the host-only, never-cached
 * editor route, and a save whose capacity the host did not touch sends no
 * `maxParticipants`, so a stale load can never move an event's capacity.
 */

jest.mock("../../utils/contentValidation", () => ({
  __esModule: true,
  validateTitle: () => true,
  validateDescription: () => true,
  containsProfanity: () => false,
  containsGibberish: () => false,
}));

const requireApiAuth = jest.fn();
jest.mock("../../lib/auth-helpers", () => ({
  __esModule: true,
  requireApiAuth: () => requireApiAuth(),
}));
jest.mock("../../lib/auth-server", () => ({
  __esModule: true,
  getSession: jest.fn(),
}));

import { WebinarService } from "@/components/planner/services/events/webinar-service";
import { ClassService } from "@/components/planner/services/events/class-service";
import { withoutUntouchedCapacity } from "@/components/offerings/editor/adapters";
import { loadOfferingEvent } from "@/components/offerings/editor/load-offering";
import { planEditorResponse } from "@/lib/api/plans/detail-response";
import type { ClassEvent, WebinarEvent } from "@/types/planner-events";

const loaded = { id: "plan-1", title: "Deep work", maxParticipants: 46 };

describe("a save with an untouched capacity", () => {
  it("strips the capacity and the update body carries none", () => {
    const values = withoutUntouchedCapacity(loaded, { capacityEdited: false });
    expect(values).not.toHaveProperty("maxParticipants");

    const webinar = WebinarService.buildRequestBody(
      { webinarPlan: values as unknown as WebinarEvent["webinarPlan"] },
      "cp-1",
      [],
      null,
      true,
      "plan-1",
      "web-1",
    );
    const cls = ClassService.buildRequestBody(
      { classPlan: values as unknown as ClassEvent["classPlan"] },
      "cp-1",
      [],
      true,
      "plan-1",
      "cls-1",
    );
    expect(webinar).not.toHaveProperty("maxParticipants");
    expect(cls).not.toHaveProperty("maxParticipants");
  });

  it("keeps an edited capacity, and a create always sends one", () => {
    expect(
      withoutUntouchedCapacity(loaded, { capacityEdited: true }),
    ).toHaveProperty("maxParticipants", 46);
    const created = WebinarService.buildRequestBody(
      {
        webinarPlan: { title: "New" } as unknown as WebinarEvent["webinarPlan"],
      },
      "cp-1",
      [],
      null,
      false,
      "",
      "",
    );
    expect(created).toHaveProperty("maxParticipants", 1);
  });
});

describe("the editor read", () => {
  it("fetches the host-only editor route with no-store", async () => {
    const fetchMock = jest.fn(async () => ({
      status: 200,
      ok: true,
      json: async () => ({ data: { ...loaded, webinars: [] } }),
    }));
    global.fetch = fetchMock as unknown as typeof fetch;

    await loadOfferingEvent("webinar", "plan-1", null);
    await loadOfferingEvent("class", "plan-2", null);

    expect(fetchMock.mock.calls).toEqual([
      ["/api/plans/webinars/plan-1/editor", { cache: "no-store" }],
      ["/api/plans/classes/plan-2/editor", { cache: "no-store" }],
    ]);
  });

  it("answers the owner and an accepted co-host privately and 404s anyone else", async () => {
    const plan = {
      consultantProfile: { userId: "u-host" },
      collaborators: [{ consultantProfile: { userId: "u-cohost" } }],
    };
    const answer = async (userId: string) => {
      requireApiAuth.mockResolvedValueOnce({
        session: { user: { id: userId } },
      });
      return planEditorResponse(async () => plan, "Webinar plan not found");
    };

    for (const userId of ["u-host", "u-cohost"]) {
      const res = await answer(userId);
      expect(res.status).toBe(200);
      expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    }
    const stranger = await answer("u-other");
    expect(stranger.status).toBe(404);
    expect(stranger.headers.get("Cache-Control")).toBe("private, no-store");
  });
});
