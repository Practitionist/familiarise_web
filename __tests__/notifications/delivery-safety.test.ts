/** @jest-environment node */
const mockUsers = jest.fn();
const mockUpdate = jest.fn();
const mockTrigger = jest.fn();
jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  default: {
    user: { findMany: (...args: unknown[]) => mockUsers(...args) },
    notificationOutbox: { update: (...args: unknown[]) => mockUpdate(...args) },
  },
}));
jest.mock("@/lib/novu/client", () => ({
  isNovuConfigured: () => true,
  getNovuClient: () => ({
    trigger: (...args: unknown[]) => mockTrigger(...args),
  }),
}));
jest.mock("@sentry/nextjs", () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));
import { attemptTrigger, type StagedTrigger } from "@/lib/novu/outbox";
import { resolveRecipientBellPolicy } from "@/lib/novu/policy";
import { DEAD_LETTER_NOTIFICATION_WHERE } from "@/lib/backoffice/queue-predicates";
const now = new Date("2026-11-06T00:00:00Z");
const row: StagedTrigger = {
  id: "bell1",
  createdAt: new Date(now.getTime() - 3600000),
  workflowId: "appointment-booked",
  kind: "MULTI",
  recipients: ["u1", "u2"],
  payload: { dashboardUrl: "/dashboard" },
  transactionId: "stable-original-key",
  attempts: 1,
  status: "RETRY",
  notBefore: null,
};
beforeEach(() => {
  jest.clearAllMocks();
  mockUsers.mockResolvedValue([
    { id: "u1", erasedAt: null },
    { id: "u2", erasedAt: null },
  ]);
  mockUpdate.mockResolvedValue({});
  mockTrigger.mockResolvedValue({});
});
it("checks current account policy before an unchanged provider request", async () => {
  expect(
    (await attemptTrigger(row, { relay: true, now: () => now.getTime() }))
      .outcome,
  ).toBe("SENT");
  expect(mockUsers).toHaveBeenCalledTimes(1);
  expect(mockTrigger).toHaveBeenCalledWith(
    expect.objectContaining({
      to: ["u1", "u2"],
      transactionId: "stable-original-key",
    }),
    "stable-original-key",
  );
});
it.each(
  [
    [
      { id: "u1", erasedAt: new Date() },
      { id: "u2", erasedAt: null },
    ],
    [
      { id: "u1", notificationPreferences: { allNotifications: false } },
      { id: "u2" },
    ],
    [{ id: "u2" }],
  ].map((users) => ({ users })),
)(
  "preserves a shared audience for review if one recipient is erased, missing or opted out",
  async ({ users }) => {
    mockUsers.mockResolvedValue(users);
    expect(
      await attemptTrigger(row, { relay: true, now: () => now.getTime() }),
    ).toEqual({
      success: false,
      error: "review:audience_changed",
      outcome: "DEAD_LETTER",
    });
    expect(mockUpdate).toHaveBeenCalledWith({
      where: { id: "bell1" },
      data: { status: "DEAD_LETTER", lastError: "review:audience_changed" },
    });
    expect(mockTrigger).not.toHaveBeenCalled();
    expect(row.recipients).toEqual(["u1", "u2"]);
    expect(row.transactionId).toBe("stable-original-key");
  },
);
it("keeps a policy read failure pending without a provider call", async () => {
  mockUsers.mockRejectedValueOnce(new Error("DB unavailable"));
  expect(
    await attemptTrigger(row, { relay: true, now: () => now.getTime() }),
  ).toMatchObject({ success: false, outcome: "PENDING" });
  expect(mockTrigger).not.toHaveBeenCalled();
  expect(mockUpdate).not.toHaveBeenCalled();
});
it("keeps expired acceptance ambiguity visible instead of retrying beyond the provider window", async () => {
  expect(
    await attemptTrigger(
      { ...row, createdAt: new Date(now.getTime() - 25 * 3600000) },
      { relay: true, now: () => now.getTime() },
    ),
  ).toMatchObject({
    success: false,
    outcome: "DEAD_LETTER",
    error: "review:provider_acceptance_unknown",
  });
  expect(mockTrigger).not.toHaveBeenCalled();
});
it("validates workflow and scalar payload context before sending", async () => {
  expect(
    (
      await attemptTrigger(
        { ...row, workflowId: "unknown" },
        { now: () => now.getTime() },
      )
    ).outcome,
  ).toBe("DEAD_LETTER");
  expect(
    (
      await attemptTrigger(
        { ...row, payload: { nested: ["invalid"] } },
        { now: () => now.getTime() },
      )
    ).outcome,
  ).toBe("DEAD_LETTER");
  expect(mockTrigger).not.toHaveBeenCalled();
});
it("also excludes erased recipients at staging and keeps expected cancellations out of recovery", async () => {
  mockUsers.mockResolvedValue([{ id: "u1", erasedAt: new Date() }]);
  expect(
    (await resolveRecipientBellPolicy("appointment-booked", ["u1"]))
      .allowedRecipients,
  ).toEqual([]);
  expect(JSON.stringify(DEAD_LETTER_NOTIFICATION_WHERE)).toContain(
    "recipient:audience_changed",
  );
});

it("treats a wholly revoked audience as an expected cancellation", async () => {
  mockUsers.mockResolvedValue([]);
  expect(
    await attemptTrigger(
      { ...row, kind: "SINGLE", recipients: ["u1"] },
      { now: () => now.getTime() },
    ),
  ).toEqual({ success: true, outcome: "DEAD_LETTER" });
  expect(mockUpdate).toHaveBeenCalledWith({
    where: { id: "bell1" },
    data: { status: "DEAD_LETTER", lastError: "recipient:audience_changed" },
  });
});
