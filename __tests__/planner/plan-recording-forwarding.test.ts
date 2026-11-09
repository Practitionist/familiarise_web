/**
 * @jest-environment node
 */

jest.mock("../../utils/contentValidation", () => ({
  __esModule: true,
  validateTitle: () => true,
  validateDescription: () => true,
  containsProfanity: () => false,
  containsGibberish: () => false,
}));

import { WebinarService } from "@/components/planner/services/events/webinar-service";
import { ClassService } from "@/components/planner/services/events/class-service";
import type { WebinarEvent, ClassEvent } from "@/types/planner-events";

describe("Plan Builder recording settings & session duration forwarding", () => {
  it("forwards recordingEnabled and shareRecordingsWithAllAttendees in WebinarService.buildRequestBody and omits them on partial updates when undefined", () => {
    const bodyShared = WebinarService.buildRequestBody(
      {
        webinarPlan: {
          title: "Deep Dive Webinar",
          description: "Architectural walkthrough",
          price: 1500,
          priceCurrency: "INR",
          durationInHours: 1.5,
          maxParticipants: 50,
          recordingEnabled: true,
          shareRecordingsWithAllAttendees: true,
        } as unknown as WebinarEvent["webinarPlan"],
      },
      "cp-1",
      ["Architecture"],
      null,
      false,
      "",
      "",
    );

    expect(bodyShared.recordingEnabled).toBe(true);
    expect(bodyShared.shareRecordingsWithAllAttendees).toBe(true);

    const partialUpdate = WebinarService.buildRequestBody(
      {
        webinarPlan: {
          id: "plan-1",
          title: "Rescheduled Webinar",
          price: 500,
          durationInHours: 1,
          maxParticipants: 100,
        } as unknown as WebinarEvent["webinarPlan"],
      },
      "cp-1",
      ["Q&A"],
      null,
      true,
      "plan-1",
      "web-1",
    );

    expect(partialUpdate.recordingEnabled).toBeUndefined();
    expect(partialUpdate.shareRecordingsWithAllAttendees).toBeUndefined();
  });

  it("forwards recordingEnabled and sessionDurationInHours in ClassService.buildRequestBody and preserves them on partial updates", () => {
    const body = ClassService.buildRequestBody(
      {
        classPlan: {
          title: "Full-Stack Cohort",
          description: "8-week cohort",
          price: 12000,
          priceCurrency: "INR",
          durationInMonths: 2,
          maxParticipants: 25,
          sessionsPerWeek: 2,
          sessionDurationInHours: 1.5,
          recordingEnabled: true,
          classContents: [],
        } as unknown as ClassEvent["classPlan"],
      },
      "cp-1",
      ["Full-Stack"],
      false,
      "",
      "",
      null,
    );

    expect(body.recordingEnabled).toBe(true);
    expect(body.sessionDurationInHours).toBe(1.5);

    const partialClassUpdate = ClassService.buildRequestBody(
      {
        classPlan: {
          id: "cplan-1",
          title: "Updated Cohort",
          description: "8-week cohort",
          price: 12000,
          durationInMonths: 2,
          maxParticipants: 25,
          sessionsPerWeek: 2,
        } as unknown as ClassEvent["classPlan"],
      },
      "cp-1",
      ["Full-Stack"],
      true,
      "cplan-1",
      "cls-1",
      null,
    );

    expect(partialClassUpdate.recordingEnabled).toBeUndefined();
  });
});

it("sends a cleared waitlist size as null so the PATCH resets it", () => {
  const webinarBody = WebinarService.buildRequestBody(
    {
      webinarPlan: {
        title: "Deep Dive Webinar",
        price: 500,
        durationInHours: 1,
        maxParticipants: 50,
        waitlistEnabled: true,
        waitlistMax: undefined,
      } as unknown as WebinarEvent["webinarPlan"],
    },
    "cp-1",
    ["Q&A"],
    null,
    true,
    "plan-1",
    "web-1",
  );
  const classBody = ClassService.buildRequestBody(
    {
      classPlan: {
        title: "Cohort",
        price: 500,
        maxParticipants: 25,
        sessionsPerWeek: 1,
        classContents: [],
        waitlistMax: undefined,
      } as unknown as ClassEvent["classPlan"],
    },
    "cp-1",
    ["Full-Stack"],
    true,
    "cplan-1",
    "cls-1",
    null,
  );
  for (const body of [webinarBody, classBody]) {
    expect(JSON.parse(JSON.stringify(body))).toHaveProperty(
      "waitlistMax",
      null,
    );
  }
});
