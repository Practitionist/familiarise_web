/** @jest-environment node */
import {
  providerWindowRefusal,
  stampFirstAttempt,
  PROVIDER_WINDOW_EXPIRED,
} from "@/lib/retry/provider-window";
import { emailReplayRefusal } from "@/lib/email/replay-policy";

const HOUR = 3_600_000;
const now = new Date("2026-11-06T00:00:00Z");
const hoursAgo = (h: number) => new Date(now.getTime() - h * HOUR);
const row = {
  status: "DEAD_LETTER",
  emailType: "PAYMENT_SUCCESS",
  lastError: "provider unavailable",
  resendId: null,
  sentAt: null,
  firstAttemptAt: hoursAgo(1),
};

describe("providerWindowRefusal", () => {
  it("always allows a row the provider never saw, at any age", () => {
    expect(providerWindowRefusal(null, now)).toBeNull();
    expect(emailReplayRefusal({ ...row, firstAttemptAt: null }, now)).toBe(
      null,
    );
  });

  it("allows replay under the same key inside 23 hours of the first attempt", () => {
    expect(providerWindowRefusal(hoursAgo(1), now)).toBeNull();
    expect(providerWindowRefusal(hoursAgo(22.9), now)).toBeNull();
    expect(emailReplayRefusal(row, now)).toBeNull();
  });

  it("refuses at 23 hours, keeping an hour inside the provider's 24 h key lifetime", () => {
    expect(providerWindowRefusal(hoursAgo(23), now)).toBe(
      PROVIDER_WINDOW_EXPIRED,
    );
    expect(providerWindowRefusal(hoursAgo(48), now)).toBe(
      PROVIDER_WINDOW_EXPIRED,
    );
    expect(
      emailReplayRefusal({ ...row, firstAttemptAt: hoursAgo(23) }, now),
    ).toBe("provider_review");
  });
});

describe("stampFirstAttempt", () => {
  it("writes only while the anchor is unset", async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    await stampFirstAttempt({ updateMany }, "row-1", now);
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "row-1", firstAttemptAt: null },
      data: { firstAttemptAt: now },
    });
  });
});

describe("emailReplayRefusal", () => {
  it.each([
    ["credential", { emailType: "PASSWORD_RESET" }],
    ["pre_launch_hold", { lastError: "held:pre-launch" }],
    ["already_accepted", { resendId: "provider-receipt" }],
    ["already_accepted", { sentAt: hoursAgo(2) }],
    ["recipient_policy", { lastError: "policy:preference_changed" }],
    ["recipient_policy", { lastError: "suppressed:COMPLAINT" }],
    [
      "provider_review",
      {
        lastError: "review:provider_acceptance_unknown",
        firstAttemptAt: hoursAgo(30),
      },
    ],
    ["not_dead_letter", { status: "PENDING" }],
  ])("keeps %s messages outside generic replay", (reason, changes) => {
    expect(emailReplayRefusal({ ...row, ...changes }, now)).toBe(reason);
  });
});
