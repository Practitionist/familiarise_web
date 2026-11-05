/** @jest-environment node */
const mockFindMany = jest.fn();
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    user: { findMany: (...args: unknown[]) => mockFindMany(...args) },
  },
}));
import { resolveRecipientBellPolicy } from "@/lib/novu/policy";

beforeEach(() => {
  jest.useFakeTimers().setSystemTime(new Date("2026-11-05T01:00:00Z"));
  mockFindMany.mockReset();
});
afterEach(() => jest.useRealTimers());

it("does not turn a failed preference read into delivery permission", async () => {
  mockFindMany.mockRejectedValue(new Error("pool unavailable"));
  await expect(
    resolveRecipientBellPolicy("payment-success", ["user"]),
  ).rejects.toThrow("pool unavailable");
});

it("drops absent users and keeps users with no preference row", async () => {
  mockFindMany.mockResolvedValue([
    { id: "live", notificationPreferences: null },
  ]);
  expect(
    (await resolveRecipientBellPolicy("payment-success", ["gone", "live"]))
      .allowedRecipients,
  ).toEqual(["live"]);
});

it("uses only the caller's transaction client", async () => {
  const findMany = jest.fn().mockResolvedValue([{ id: "live" }]);
  const tx = { user: { findMany } };
  await resolveRecipientBellPolicy("payment-success", ["live"], {
    tx: tx as never,
  });
  expect(findMany).toHaveBeenCalledTimes(1);
  expect(mockFindMany).not.toHaveBeenCalled();
});

it.each([
  "account-security-notice",
  "payment-failed",
  "refund-failed",
  "payout-failed",
  "org-payout-failed",
  "dispute-created",
  "compliance-deadline-alert",
] as const)("does not defer urgent %s during quiet hours", async (workflow) => {
  mockFindMany.mockResolvedValue([
    {
      id: "live",
      timezone: "UTC",
      notificationPreferences: {
        quietHoursEnabled: true,
        quietHoursStart: "22:00",
        quietHoursEnd: "08:00",
        quietHoursTimezone: "UTC",
      },
    },
  ]);
  const urgent = await resolveRecipientBellPolicy(workflow, ["live"]);
  expect(urgent.allowedRecipients).toEqual(["live"]);
  expect(urgent.notBefore).toBeUndefined();
  expect(
    (await resolveRecipientBellPolicy("payment-success", ["live"])).notBefore,
  ).toBeInstanceOf(Date);
});
