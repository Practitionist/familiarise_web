/** @jest-environment node */

import { extractCallbackInfo } from "@/lib/support/case-read";
import { slaStateOf } from "@/lib/support/sla";
import {
  PlatformFeedbackStatusSchema,
  RatingCauseSchema,
} from "@/schemas/enums";
import { CreateReviewSchema, UpdateReviewSchema } from "@/schemas/feedbacks";

describe("Support, Feedback & Review Megafix invariants", () => {
  describe("extractCallbackInfo", () => {
    it("extracts explicit [Callback Requested: <phone>] header over fallback phone", () => {
      const info = extractCallbackInfo(
        [
          "[Callback Requested: +91-9876543210]\n\nUrgent payout failure during settlement.",
        ],
        "+91-1111111111",
      );
      expect(info).toEqual({
        phone: "+91-9876543210",
        callbackRequested: true,
      });
    });

    it("falls back to requester profile phone when no explicit callback tag is present", () => {
      const info = extractCallbackInfo(
        ["Regular billing question about invoice PDF."],
        " +91-9988776655 ",
      );
      expect(info).toEqual({
        phone: "+91-9988776655",
        callbackRequested: false,
      });
    });

    it("returns null when neither explicit callback tag nor profile phone is present", () => {
      const info = extractCallbackInfo(["No phone mentioned."], null);
      expect(info).toEqual({
        phone: null,
        callbackRequested: false,
      });
    });
  });

  describe("RatingCause & PlatformFeedbackStatus Zod schemas", () => {
    it("validates all 6 RatingCause enum values and rejects unknown strings", () => {
      for (const cause of [
        "CONSULTANT",
        "PLATFORM_TECHNICAL",
        "PAYMENT",
        "SCHEDULING",
        "CONTENT",
        "OTHER",
      ]) {
        expect(RatingCauseSchema.parse(cause)).toBe(cause);
      }
      expect(() => RatingCauseSchema.parse("INVALID_CAUSE")).toThrow();
    });

    it("accepts optional ratingCause on CreateReviewSchema and UpdateReviewSchema", () => {
      const parsedCreate = CreateReviewSchema.parse({
        rating: 2,
        reviewDescription: "Audio dropped repeatedly during the call.",
        consultantProfileId: "550e8400-e29b-41d4-a716-446655440000",
        appointmentId: "550e8400-e29b-41d4-a716-446655440001",
        ratingCause: "PLATFORM_TECHNICAL",
      });
      expect(parsedCreate.ratingCause).toBe("PLATFORM_TECHNICAL");

      const parsedUpdate = UpdateReviewSchema.parse({
        rating: 3,
        ratingCause: "SCHEDULING",
      });
      expect(parsedUpdate.ratingCause).toBe("SCHEDULING");
    });

    it("validates ACKNOWLEDGED and all PlatformFeedbackStatus enum values", () => {
      for (const status of [
        "PENDING",
        "ACKNOWLEDGED",
        "IN_PROGRESS",
        "RESOLVED",
        "CLOSED",
      ]) {
        expect(PlatformFeedbackStatusSchema.parse(status)).toBe(status);
      }
    });
  });

  describe("SLA clock reopen invariant", () => {
    it("resumes resolutionBreached tracking when resolvedAt is cleared upon ticket reopen", () => {
      const ackDueAt = new Date("2026-10-08T11:00:00Z");
      const resolutionDueAt = new Date("2026-10-08T14:00:00Z");
      const now = new Date("2026-10-08T16:00:00Z");

      const staleReopenWithResolvedAt = slaStateOf(
        {
          status: "IN_PROGRESS",
          ackDueAt,
          acknowledgedAt: new Date("2026-10-08T10:30:00Z"),
          resolutionDueAt,
          resolvedAt: new Date("2026-10-08T13:00:00Z"),
          awaitingUserSince: null,
          pausedSeconds: 0,
        },
        now,
      );
      expect(staleReopenWithResolvedAt.resolutionBreached).toBe(false);

      const cleanReopenWithClearedResolvedAt = slaStateOf(
        {
          status: "IN_PROGRESS",
          ackDueAt,
          acknowledgedAt: new Date("2026-10-08T10:30:00Z"),
          resolutionDueAt,
          resolvedAt: null,
          awaitingUserSince: null,
          pausedSeconds: 0,
        },
        now,
      );
      expect(cleanReopenWithClearedResolvedAt.resolutionBreached).toBe(true);
    });
  });
});
