/**
 * A CONSENT_REQUIRED checkout refusal points at the viewer's own Settings ›
 * Account data-consent anchor, and offers no link when the viewer has no
 * account surface.
 */
import { renderHook } from "@testing-library/react";

let mockUser: Record<string, unknown> | null = null;
jest.mock("@/lib/auth-client", () => ({
  useSession: () => ({ data: mockUser ? { user: mockUser } : null }),
}));
const mockCreate = jest.fn(
  (..._args: unknown[]) =>
    () =>
      undefined,
);
jest.mock("@/app/checkout/plans/utils", () => ({
  createHandleApiError: (...args: unknown[]) => mockCreate(...args),
}));

import { useHandleApiError } from "@/app/checkout/plans/use-handle-api-error";

function consentHrefFor(user: Record<string, unknown> | null): unknown {
  mockUser = user;
  mockCreate.mockClear();
  const toast = jest.fn();
  renderHook(() => useHandleApiError(toast));
  expect(mockCreate.mock.calls[0][0]).toBe(toast);
  return mockCreate.mock.calls[0][1];
}

describe("useHandleApiError consent link", () => {
  it("links a consultee to their own Account data-consent section", () => {
    expect(
      consentHrefFor({ role: "CONSULTEE", consulteeProfileId: "e1" }),
    ).toBe("/dashboard/consultee/e1/settings/account#data-consent");
  });

  it("links a consultant to their own Account data-consent section", () => {
    expect(
      consentHrefFor({ role: "CONSULTANT", consultantProfileId: "c1" }),
    ).toBe("/dashboard/consultant/c1/settings/account#data-consent");
  });

  it("offers no link to a signed-out or back-office viewer", () => {
    expect(consentHrefFor(null)).toBeNull();
    expect(consentHrefFor({ role: "ADMIN" })).toBeNull();
  });
});
