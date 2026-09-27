/**
 * Pins the bell-copy label helpers: gateway codes and raw enums become
 * prose before they reach a template. Customer-visible copy must never
 * read `card_declined`, `WARNING_CLOSED` or `CO_HOST`.
 */

// humanize.ts reaches prisma for recipient timezones; nothing here does.
jest.mock("../../lib/prisma", () => ({ __esModule: true, default: {} }));

import {
  collaboratorRoleLabel,
  disputeReasonLabel,
  disputeStatusLabel,
  failureReasonLabel,
} from "@/lib/novu/humanize";

describe("failureReasonLabel", () => {
  it("maps gateway codes to sentences", () => {
    expect(failureReasonLabel("card_declined")).toBe(
      "your card was declined",
    );
    expect(failureReasonLabel("insufficient_funds")).toBe(
      "your account had insufficient funds",
    );
    expect(failureReasonLabel("expired_card")).toBe(
      "your card has expired",
    );
  });

  it("spaces out unknown codes and passes prose through", () => {
    expect(failureReasonLabel("SOME_NEW_CODE")).toBe("some new code");
    expect(failureReasonLabel("Your bank rejected the charge.")).toBe(
      "Your bank rejected the charge.",
    );
  });

  it("never leaves the sentence without a reason", () => {
    expect(failureReasonLabel(undefined)).toBe(
      "the payment could not be processed",
    );
    expect(failureReasonLabel("")).toBe("the payment could not be processed");
  });
});

describe("disputeReasonLabel", () => {
  it("maps gateway dispute reasons to clauses", () => {
    expect(disputeReasonLabel("fraudulent")).toBe(
      "a fraudulent-payment claim",
    );
    expect(disputeReasonLabel("product_not_received")).toBe(
      "goods that never arrived",
    );
    expect(disputeReasonLabel("unrecognized")).toBe(
      "a charge the cardholder does not recognize",
    );
  });

  it("is absent when there is nothing to say, so the template drops it", () => {
    expect(disputeReasonLabel(undefined)).toBeUndefined();
    expect(disputeReasonLabel("")).toBeUndefined();
  });
});

describe("disputeStatusLabel", () => {
  it("translates gateway jargon instead of downcasing it", () => {
    expect(disputeStatusLabel("NEEDS_RESPONSE")).toBe("needs a response");
    expect(disputeStatusLabel("WARNING_CLOSED")).toBe(
      "closed after an early warning",
    );
    expect(disputeStatusLabel("WON")).toBe("won");
    expect(disputeStatusLabel("LOST")).toBe("lost");
  });

  it("is absent when there is nothing to say", () => {
    expect(disputeStatusLabel(undefined)).toBeUndefined();
  });
});

describe("collaboratorRoleLabel", () => {
  it("keeps real hyphens the template cannot produce", () => {
    expect(collaboratorRoleLabel("CO_HOST")).toBe("Co-host");
    expect(collaboratorRoleLabel("GUEST_SPEAKER")).toBe("Guest speaker");
    expect(collaboratorRoleLabel("TECHNICAL_SUPPORT")).toBe(
      "Technical support",
    );
    expect(collaboratorRoleLabel("MODERATOR")).toBe("Moderator");
  });

  it("title-cases future roles instead of shouting them", () => {
    expect(collaboratorRoleLabel("STAGE_MANAGER")).toBe("Stage Manager");
  });

  it("falls back to a noun, never blank", () => {
    expect(collaboratorRoleLabel(undefined)).toBe("Collaborator");
    expect(collaboratorRoleLabel("")).toBe("Collaborator");
  });
});
