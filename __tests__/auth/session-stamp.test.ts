/**
 * @jest-environment node
 */

/**
 * Post-create device stamp (#1856). Lives in `create.after` (not the
 * insert) precisely so a missing column can never brick sign-in: the
 * update fails throttled-quiet and the row fills in once the push
 * lands, with read-time derivation covering the gap.
 */

const sessionUpdate = jest.fn();
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    session: { update: (...a: unknown[]) => sessionUpdate(...a) },
  },
}));

const throttledCapture = jest.fn();
jest.mock("../../lib/observability/throttled-capture", () => ({
  __esModule: true,
  captureThrottled: (...a: unknown[]) => throttledCapture(...a),
}));

import { stampSessionDeviceMetadata } from "../../lib/auth/session-stamp";

beforeEach(() => {
  jest.clearAllMocks();
});

describe("stampSessionDeviceMetadata (#1856)", () => {
  it("writes the derived label and creation-time lastSeenAt", async () => {
    sessionUpdate.mockResolvedValue({ id: "s1" });

    await stampSessionDeviceMetadata(
      "s1",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    );

    expect(sessionUpdate).toHaveBeenCalledWith({
      where: { id: "s1" },
      data: {
        deviceLabel: "Chrome on Windows",
        lastSeenAt: expect.any(Date),
      },
    });
    expect(throttledCapture).not.toHaveBeenCalled();
  });

  it("never throws — a missing column resolves quietly (sign-in survives pre-push)", async () => {
    sessionUpdate.mockRejectedValue(
      new Error('column "deviceLabel" does not exist'),
    );

    await expect(
      stampSessionDeviceMetadata("s1", "curl/8.0"),
    ).resolves.toBeUndefined();
    expect(throttledCapture).toHaveBeenCalledWith(
      "session:stampDevice",
      expect.any(Error),
      // `expected: true` and `level: "warning"` are load-bearing, not
      // decoration: pre-push EVERY sign-in fails this update, and the
      // production comment says an unthrottled capture at error level
      // "would page per sign-in". `objectContaining({ subsystem })`
      // alone would not notice either flag being dropped.
      expect.objectContaining({
        subsystem: "auth",
        op: "stampSessionDeviceMetadata",
        expected: true,
        level: "warning",
      }),
    );
  });
});
