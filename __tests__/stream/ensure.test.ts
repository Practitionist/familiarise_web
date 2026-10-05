/**
 * @jest-environment node
 */

const mockEnsureAppSettings = jest.fn();
const mockEnsureCallTypeGrants = jest.fn();
const mockHardenUnusedCallTypes = jest.fn();
const mockGetCallType = jest.fn();
const mockUpdateCallType = jest.fn();

jest.mock("../../scripts/stream/ensure-app-settings", () => ({
  ensureAppSettings: (...a: unknown[]) => mockEnsureAppSettings(...a),
}));

jest.mock("../../scripts/stream/ensure-call-type-grants", () => ({
  ensureCallTypeGrants: (...a: unknown[]) => mockEnsureCallTypeGrants(...a),
}));

jest.mock("../../scripts/stream/harden-unused-call-types", () => ({
  hardenUnusedCallTypes: (...a: unknown[]) => mockHardenUnusedCallTypes(...a),
}));

jest.mock("../../lib/stream-client", () => ({
  isStreamConfigured: jest.fn(() => true),
  getStreamVideoClient: jest.fn(() => ({
    listRoles: async () => ({ roles: [{ name: "co_presenter" }] }),
    video: {
      getCallType: (...a: unknown[]) => mockGetCallType(...a),
      updateCallType: (...a: unknown[]) => mockUpdateCallType(...a),
    },
  })),
}));

import {
  CO_PRESENTER_GRANTS,
  ensureDefaultCallTypeSettings,
  ensureStreamConfig,
  TARGET_INACTIVITY_TIMEOUT_SECONDS,
} from "../../scripts/stream/ensure";

beforeEach(() => {
  jest.clearAllMocks();
  mockEnsureAppSettings.mockResolvedValue(0);
  mockEnsureCallTypeGrants.mockResolvedValue(0);
  mockHardenUnusedCallTypes.mockResolvedValue(0);
  mockGetCallType
    .mockResolvedValue({
      name: "default",
      grants: { co_presenter: CO_PRESENTER_GRANTS },
    })
    .mockResolvedValueOnce({
      name: "default",
      settings: { session: { inactivity_timeout_seconds: 60 } },
    })
    .mockResolvedValueOnce({
      name: "default",
      settings: {
        session: {
          inactivity_timeout_seconds: TARGET_INACTIVITY_TIMEOUT_SECONDS,
        },
      },
    });
  mockUpdateCallType.mockResolvedValue({});
});

describe("scripts/stream/ensure", () => {
  it("runs all five ensure steps in sequence", async () => {
    const code = await ensureStreamConfig({
      apply: true,
      deployConfirmed: true,
    });

    expect(code).toBe(0);
    expect(mockEnsureAppSettings).toHaveBeenCalledWith({ apply: true });
    expect(mockEnsureCallTypeGrants).toHaveBeenCalledWith({
      apply: true,
      restore: false,
      deployConfirmed: true,
    });
    expect(mockHardenUnusedCallTypes).toHaveBeenCalledWith({ apply: true });
    expect(mockUpdateCallType).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "default",
        settings: expect.objectContaining({
          session: { inactivity_timeout_seconds: 300 },
        }),
      }),
    );
    expect(mockUpdateCallType).toHaveBeenCalledTimes(1);
  });

  it("is a no-op when session.inactivity_timeout_seconds is already 300", async () => {
    mockGetCallType.mockReset();
    mockGetCallType.mockResolvedValue({
      name: "default",
      settings: { session: { inactivity_timeout_seconds: 300 } },
    });

    const code = await ensureDefaultCallTypeSettings({ apply: true });

    expect(code).toBe(0);
    expect(mockUpdateCallType).not.toHaveBeenCalled();
  });

  it("stops early if an earlier step returns a non-zero exit code", async () => {
    mockEnsureCallTypeGrants.mockResolvedValue(1);

    const code = await ensureStreamConfig({
      apply: true,
      deployConfirmed: true,
    });

    expect(code).toBe(1);
    expect(mockHardenUnusedCallTypes).not.toHaveBeenCalled();
  });
});
