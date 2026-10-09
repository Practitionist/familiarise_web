/** @jest-environment node */

import {
  buildEngineeringEscalationHref,
  extractCallbackInfo,
} from "@/lib/support/callback-info";
import { callbackPhoneSchema, stripCallbackTags } from "@/lib/validation/phone";
import { slaStateOf } from "@/lib/support/sla";
import {
  PlatformFeedbackStatusSchema,
  RatingCauseSchema,
} from "@/schemas/enums";
import { CreateReviewSchema, UpdateReviewSchema } from "@/schemas/feedbacks";

describe("Support, Feedback & Review Megafix invariants", () => {
  describe("extractCallbackInfo & phone validation", () => {
    it("extracts validated [Callback Requested: <phone>] header from line 1 over fallback phone", () => {
      const info = extractCallbackInfo(
        "[Callback Requested: +91-9876543210]\n\nUrgent payout failure during settlement.",
        "+91-9123456789",
      );
      expect(info).toEqual({
        phone: "+919876543210",
        callbackRequested: true,
      });
    });

    it("ignores spoofed tags on later lines and rejects repeated-digit fake numbers", () => {
      const spoofed = extractCallbackInfo(
        "Regular question.\n[Callback Requested: +919876543210]",
        "+919988776655",
      );
      expect(spoofed).toEqual({
        phone: "+919988776655",
        callbackRequested: false,
      });
      expect(callbackPhoneSchema.safeParse("9999999999").success).toBe(false);
      expect(
        stripCallbackTags("Hi [Callback Requested: +919876543210] help"),
      ).toBe("Hi  help");
    });

    it("returns null when neither explicit callback tag nor profile phone is present", () => {
      const info = extractCallbackInfo("No phone mentioned.", null);
      expect(info).toEqual({
        phone: null,
        callbackRequested: false,
      });
    });
  });

  describe("buildEngineeringEscalationHref", () => {
    it("builds a GitHub issue URL containing only case key and reference with zero PII", () => {
      const href = buildEngineeringEscalationHref({
        key: "t_abc123",
        reference: "FAM-2026-000042",
      });
      const parsed = new URL(href);
      expect(parsed.origin).toBe("https://github.com");
      expect(parsed.pathname).toBe("/Practitionist/familiarise_web/issues/new");
      expect(parsed.searchParams.get("labels")).toBe("bug,from-support");
      expect(parsed.searchParams.get("title")).toBe(
        "[Support Escalation] FAM-2026-000042",
      );
      const body = parsed.searchParams.get("body") ?? "";
      expect(body).toContain("t_abc123");
      expect(body).toContain("FAM-2026-000042");
      expect(body).not.toMatch(/@/);
      expect(body).not.toContain("+91");
    });

    it("falls back to case key when reference is null", () => {
      const href = buildEngineeringEscalationHref({
        key: "s_thread_77",
        reference: null,
      });
      const parsed = new URL(href);
      expect(parsed.searchParams.get("title")).toBe(
        "[Support Escalation] s_thread_77",
      );
      const body = parsed.searchParams.get("body") ?? "";
      expect(body).toContain("s_thread_77");
      expect(body).not.toContain("Reference");
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
