/** @jest-environment node */
const findItem = jest.fn();
const completeTransaction = jest.fn();
const updateItem = jest.fn(async (..._args: unknown[]) => ({ count: 1 }));
const updateRequest = jest.fn();
const freeze = jest.fn();
const gate = jest.fn();
const findOccurrences = jest.fn();
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    $transaction: (run: (tx: unknown) => Promise<unknown>) =>
      completeTransaction(run),
    maintenanceWindow: { findFirst: async () => ({ id: "window" }) },
    appointment: {
      findMany: (...args: unknown[]) => findOccurrences(...args),
    },
    maintenanceRemediationItem: {
      findFirst: (...args: unknown[]) => findItem(...args),
      updateMany: (...args: unknown[]) => updateItem(...args),
      count: async () => 0,
    },
    maintenanceRemediation: {
      updateMany: (...args: unknown[]) => updateRequest(...args),
    },
  },
}));
jest.mock("../../actions/maintenance/freeze-appointments", () => ({
  freezeAppointments: (...args: unknown[]) => freeze(...args),
}));
jest.mock("../../lib/maintenance-cron", () => ({
  assertNotInMaintenance: (...args: unknown[]) => gate(...args),
}));
jest.mock("../../lib/cron/with-cron-lock", () => ({
  withCronLock: async (
    _name: string,
    _opts: unknown,
    run: () => Promise<unknown>,
  ) => run(),
}));
import {
  previewRemediation,
  confirmRemediation,
  runMaintenanceRemediationSlice,
} from "../../lib/maintenance-remediation";

const item = {
  id: "item",
  remediationId: "request",
  appointmentId: "booking",
  remediation: {
    startsAt: new Date("2026-10-22T01:00Z"),
    endsAt: new Date("2026-10-22T02:00Z"),
  },
};
beforeEach(() => {
  jest.clearAllMocks();
  process.env.BETTER_AUTH_SECRET = "isolated-test-signing-secret";
  findItem.mockResolvedValue(item);
  freeze.mockResolvedValue({ freezeErrors: 0 });
  completeTransaction.mockImplementation((run) =>
    run({
      maintenanceRemediationItem: {
        updateMany: (...args: unknown[]) => updateItem(...args),
        count: async () => 0,
      },
      maintenanceRemediation: {
        updateMany: (...args: unknown[]) => updateRequest(...args),
      },
    }),
  );
});
it("holds confirmed cancellations when maintenance state is unavailable", async () => {
  gate.mockRejectedValueOnce(new Error("unknown maintenance"));
  await expect(runMaintenanceRemediationSlice()).rejects.toThrow(
    "unknown maintenance",
  );
  expect(freeze).not.toHaveBeenCalled();
  expect(findItem).not.toHaveBeenCalled();
});
it("processes one selected booking and delegates refund delivery to its durable marker", async () => {
  expect(await runMaintenanceRemediationSlice()).toMatchObject({
    success: true,
    processed: 1,
  });
  expect(freeze).toHaveBeenCalledWith(
    item.remediation.startsAt,
    item.remediation.endsAt,
    "booking",
  );
  expect(updateItem).toHaveBeenCalledWith(
    expect.objectContaining({
      data: expect.objectContaining({ completedAt: expect.any(Date) }),
    }),
  );
});
it("retains a failed item for retry rather than marking the request complete", async () => {
  freeze.mockRejectedValueOnce(new Error("serialization conflict"));
  await expect(runMaintenanceRemediationSlice()).rejects.toThrow(
    "serialization conflict",
  );
  expect(updateRequest).not.toHaveBeenCalled();
  expect(updateItem).toHaveBeenLastCalledWith(
    expect.objectContaining({ data: { lastError: "serialization conflict" } }),
  );
});
it("replays after a completion-write crash without creating another request", async () => {
  updateItem
    .mockResolvedValueOnce({ count: 1 })
    .mockRejectedValueOnce(new Error("lost completion write"));
  await expect(runMaintenanceRemediationSlice()).rejects.toThrow(
    "lost completion write",
  );
  expect(await runMaintenanceRemediationSlice()).toMatchObject({
    processed: 1,
  });
  expect(freeze).toHaveBeenCalledTimes(2);
});
it("does nothing once the durable queue is complete", async () => {
  findItem.mockResolvedValue(null);
  expect(await runMaintenanceRemediationSlice()).toEqual({
    success: true,
    processed: 0,
  });
  expect(freeze).not.toHaveBeenCalled();
});
it("binds confirmation to previewed bookings, ADMIN identity and expiry", async () => {
  findOccurrences.mockResolvedValue([
    {
      id: "booking",
      appointmentType: "CONSULTATION",
      occurrences: [
        {
          startsAt: new Date("2026-10-22T01:00Z"),
          endsAt: new Date("2026-10-22T02:00Z"),
        },
      ],
      participants: [{ user: { name: "Client" } }],
      _count: { occurrences: 1, participants: 1, payment: 0 },
    },
  ]);
  const preview = await previewRemediation(
    {
      windowId: "window",
      startsAt: "2026-10-22T01:00:00Z",
      endsAt: "2026-10-22T02:00:00Z",
    },
    "admin",
  );
  expect(
    confirmRemediation(preview.token, "CANCEL 1 BOOKINGS", "admin")
      .appointmentIds,
  ).toEqual(["booking"]);
  expect(() =>
    confirmRemediation(preview.token, "CANCEL 1 BOOKINGS", "another-admin"),
  ).toThrow();
  expect(() =>
    confirmRemediation(preview.token + "0", "CANCEL 1 BOOKINGS", "admin"),
  ).toThrow();
  const now = jest.spyOn(Date, "now").mockReturnValue(preview.expiresAt + 1);
  expect(() =>
    confirmRemediation(preview.token, "CANCEL 1 BOOKINGS", "admin"),
  ).toThrow();
  now.mockRestore();
});
it("refuses an unbounded preview cohort", async () => {
  findOccurrences.mockResolvedValue(
    Array.from({ length: 21 }, (_, i) => ({ id: String(i) })),
  );
  await expect(
    previewRemediation(
      {
        windowId: "window",
        startsAt: "2026-10-22T01:00:00Z",
        endsAt: "2026-10-22T02:00:00Z",
      },
      "admin",
    ),
  ).rejects.toThrow("between 1 and 20");
});

it("refuses a preview whose single booking exceeds the recipient envelope", async () => {
  findOccurrences.mockResolvedValue([
    { id: "large", _count: { occurrences: 1, participants: 9000, payment: 1 } },
  ]);
  await expect(
    previewRemediation(
      {
        windowId: "window",
        startsAt: "2026-10-22T01:00:00Z",
        endsAt: "2026-10-22T02:00:00Z",
      },
      "admin",
    ),
  ).rejects.toThrow("exceeds automatic maintenance remediation capacity");
  expect(freeze).not.toHaveBeenCalled();
});
