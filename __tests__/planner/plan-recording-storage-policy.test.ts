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
import { OFFERING_ADAPTERS } from "@/components/offerings/editor/adapters";
import type { WebinarEvent, ClassEvent } from "@/types/planner-events";

describe("Plan Builder Recording Storage Policy & Session Duration Forwarding", () => {
  it("defaults webinar and class offering adapters to PERMANENT recordingStoragePolicy", () => {
    expect(OFFERING_ADAPTERS.webinar.defaults.recordingStoragePolicy).toBe(
      "PERMANENT",
    );
    expect(OFFERING_ADAPTERS.class.defaults.recordingStoragePolicy).toBe(
      "PERMANENT",
    );
  });

  it("forwards recordingEnabled and recordingStoragePolicy in WebinarService.buildRequestBody", () => {
    const bodyPermanent = WebinarService.buildRequestBody(
      {
        webinarPlan: {
          title: "Deep Dive Webinar",
          description: "Architectural walkthrough",
          price: 1500,
          priceCurrency: "INR",
          durationInHours: 1.5,
          maxParticipants: 50,
          recordingEnabled: true,
          recordingStoragePolicy: "PERMANENT",
        } as unknown as WebinarEvent["webinarPlan"],
      },
      "cp-1",
      ["Architecture"],
      null,
      false,
      "",
      "",
    );

    expect(bodyPermanent.recordingEnabled).toBe(true);
    expect(bodyPermanent.recordingStoragePolicy).toBe("PERMANENT");

    const bodyStreamOnly = WebinarService.buildRequestBody(
      {
        webinarPlan: {
          title: "Quick Q&A Webinar",
          description: "Live Q&A",
          price: 500,
          priceCurrency: "INR",
          durationInHours: 1,
          maxParticipants: 100,
          recordingEnabled: false,
          recordingStoragePolicy: "STREAM_ONLY",
        } as unknown as WebinarEvent["webinarPlan"],
      },
      "cp-1",
      ["Q&A"],
      null,
      true,
      "plan-1",
      "web-1",
    );

    expect(bodyStreamOnly.recordingEnabled).toBe(false);
    expect(bodyStreamOnly.recordingStoragePolicy).toBe("STREAM_ONLY");
  });

  it("forwards recordingEnabled, recordingStoragePolicy, and sessionDurationInHours in ClassService.buildRequestBody", () => {
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
          recordingStoragePolicy: "PERMANENT",
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
    expect(body.recordingStoragePolicy).toBe("PERMANENT");
    expect(body.sessionDurationInHours).toBe(1.5);
  });
});
