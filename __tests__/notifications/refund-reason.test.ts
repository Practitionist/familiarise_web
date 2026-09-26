/**
 * Pins refundReasonLabel: the ops `refund-requested` bell shows human copy
 * while the Refund row keeps the machine string.
 *
 * Regression for the inbox that read "class session 4424e3fe-… skipped",
 * "removed from webinar aded473c-… by the attendee (100%)" and
 * "whole-event class cancellation (OTHER)".
 */

// humanize.ts reaches prisma for recipient timezones; nothing here does.
jest.mock("../../lib/prisma", () => ({ __esModule: true, default: {} }));

import { refundReasonLabel } from "@/lib/novu/humanize";

describe("refundReasonLabel", () => {
  it("is absent when there is nothing to say, so the template drops its clause", () => {
    expect(refundReasonLabel(undefined)).toBeUndefined();
    expect(refundReasonLabel(null)).toBeUndefined();
    expect(refundReasonLabel("")).toBeUndefined();
    expect(refundReasonLabel("   ")).toBeUndefined();
  });

  it("never prints a session or event id", () => {
    expect(
      refundReasonLabel(
        "class session 4424e3fe-3e53-48ce-b8de-595b71cc6596 skipped — make-up not attended",
      ),
    ).toBe("a class session was skipped and its make-up was not attended");
    expect(
      refundReasonLabel(
        "removed from webinar aded473c-1363-40e8-a1c6-839d2dcda0ca by the attendee (100%)",
      ),
    ).toBe("removed from the webinar by the attendee (100% refund)");
    expect(
      refundReasonLabel(
        "removed from class 4424e3fe-3e53-48ce-b8de-595b71cc6596 by the organiser (50%)",
      ),
    ).toBe("removed from the class by the organiser (50% refund)");
    expect(
      refundReasonLabel(
        "left webinar aded473c-1363-40e8-a1c6-839d2dcda0ca — credits restored in full",
      ),
    ).toBe("left the webinar early; credits restored in full");
  });

  it("humanises the whole-event parenthetical instead of shouting the enum", () => {
    expect(
      refundReasonLabel("whole-event class cancellation (OTHER)"),
    ).toBe("the whole class was cancelled (a reason the other party did not specify)");
    expect(
      refundReasonLabel("whole-event webinar cancellation (MODERATION)"),
    ).toBe("the whole webinar was cancelled (a moderation decision on this account)");
    // The cancel route's default placeholder would read "cancelled (cancelled)".
    expect(
      refundReasonLabel("whole-event class cancellation (cancelled)"),
    ).toBe("the whole class was cancelled");
  });

  it("restates console prefixes as what they are — a manual refund", () => {
    expect(refundReasonLabel("ops refund: qa1824_partial_refund_test")).toBe(
      "manual refund issued by ops — qa1824_partial_refund_test",
    );
    expect(refundReasonLabel("admin refund: goodwill gesture")).toBe(
      "manual refund issued by ops — goodwill gesture",
    );
    expect(refundReasonLabel("admin whole-event refund: goodwill")).toBe(
      "manual whole-event refund issued by ops — goodwill",
    );
    expect(refundReasonLabel("ops refund:")).toBe(
      "manual refund issued by ops",
    );
  });

  it("translates the settle-sweep machine codes", () => {
    expect(refundReasonLabel("SESSION_VOIDED_NOT_MADE_UP")).toBe(
      "a voided session was never made up",
    );
    expect(refundReasonLabel("HOST_SESSION_NOT_MADE_UP")).toBe(
      "a cancelled session was never made up",
    );
    expect(refundReasonLabel("SESSION_VOIDED_UNUSED_AT_PLAN_END")).toBe(
      "an unused voided session at the end of the plan",
    );
  });

  it("drops ledger row ids from overage credit-backs", () => {
    expect(
      refundReasonLabel(
        "overage credit-back — parent booking 4424e3fe-3e53-48ce-b8de-595b71cc6596 refunded",
      ),
    ).toBe("overage credit-back after the parent booking was refunded");
  });

  it("passes already-human copy through verbatim", () => {
    const human = [
      "subscription not scheduled within 48 h — automatic full refund",
      "moderation (100% — platform-initiated cancellation)",
      "trial cancellation (100% per booking-time policy, consultant-initiated)",
      "cancellation (50% per booking-time policy, consultee-initiated)",
      "consultant no-show (#471)",
      "Scheduled platform maintenance",
      "double-booking blocked at confirmation",
    ];
    for (const reason of human) {
      expect(refundReasonLabel(reason)).toBe(reason);
    }
  });

  it("scrubs ids from builders not yet mapped instead of printing them", () => {
    expect(
      refundReasonLabel(
        "something new 4424e3fe-3e53-48ce-b8de-595b71cc6596 happened",
      ),
    ).toBe("something new that booking happened");
  });
});
