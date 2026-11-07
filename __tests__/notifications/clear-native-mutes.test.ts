/**
 * @jest-environment node
 */

/**
 * The one-time native-mute reset: a dry run only reads, an apply re-enables
 * in-app for the global preference and owned families only, and a second run
 * over its own output changes nothing.
 */

jest.mock("dotenv/config", () => ({}));

import type { GetSubscriberPreferencesDto } from "@novu/api/models/components";
import {
  clearNativeMutes,
  type NovuPreferenceApi,
} from "@/scripts/novu/clear-native-mutes";

type Prefs = GetSubscriberPreferencesDto;

function workflowPref(identifier: string, inApp: boolean) {
  return {
    enabled: inApp,
    channels: { inApp },
    overrides: [],
    workflow: { slug: identifier, identifier, name: identifier },
  };
}

/** An in-memory Novu holding per-subscriber preferences across two pages. */
function fakeNovu(initial: Record<string, Prefs>) {
  const state = structuredClone(initial);
  const ids = Object.keys(state);
  const update = jest.fn(
    async (
      dto: { channels?: { inApp?: boolean }; workflowId?: string },
      subscriberId: string,
    ) => {
      const prefs = state[subscriberId];
      if (!dto.workflowId) {
        prefs.global.channels.inApp = dto.channels?.inApp;
        return {};
      }
      const pref = prefs.workflows.find(
        (w) => w.workflow.identifier === dto.workflowId,
      )!;
      pref.channels.inApp = dto.channels?.inApp;
      return {};
    },
  );
  const novu: NovuPreferenceApi = {
    subscribers: {
      search: jest.fn(async ({ after }: { limit: number; after?: string }) => {
        const start = after ? ids.indexOf(after) + 1 : 0;
        const data = ids.slice(start, start + 1).map((subscriberId) => ({
          subscriberId,
        }));
        const last = start + 1 >= ids.length;
        return {
          result: { data, next: last ? null : data[0].subscriberId },
        };
      }),
      preferences: {
        list: jest.fn(async ({ subscriberId }: { subscriberId: string }) => ({
          result: structuredClone(state[subscriberId]),
        })),
        update,
      },
    },
  };
  return { novu, update };
}

const initial: Record<string, Prefs> = {
  u1: {
    global: { enabled: false, channels: { inApp: false } },
    workflows: [
      workflowPref("payment", false),
      workflowPref("appointment", true),
      workflowPref("someone-elses-workflow", false),
    ],
  },
  u2: {
    global: { enabled: true, channels: { inApp: true } },
    workflows: [workflowPref("org-billing", false)],
  },
  u3: {
    global: { enabled: true, channels: { inApp: true } },
    workflows: [workflowPref("payment", true)],
  },
};

describe("clearNativeMutes", () => {
  it("reports mutes on owned families and global in a dry run, writing nothing", async () => {
    const { novu, update } = fakeNovu(initial);

    const result = await clearNativeMutes(novu, { apply: false });

    expect(update).not.toHaveBeenCalled();
    expect(result.scanned).toBe(3);
    expect(result.cleared).toBe(0);
    expect(result.mutes).toEqual([
      { subscriberId: "u1", workflowId: null },
      { subscriberId: "u1", workflowId: "payment" },
      { subscriberId: "u2", workflowId: "org-billing" },
    ]);
  });

  it("re-enables only those mutes when applied, and a rerun finds none", async () => {
    const { novu, update } = fakeNovu(initial);

    const applied = await clearNativeMutes(novu, { apply: true });

    expect(applied.cleared).toBe(3);
    expect(applied.failures).toEqual([]);
    expect(update.mock.calls).toEqual([
      [{ channels: { inApp: true } }, "u1"],
      [{ channels: { inApp: true }, workflowId: "payment" }, "u1"],
      [{ channels: { inApp: true }, workflowId: "org-billing" }, "u2"],
    ]);

    update.mockClear();
    const rerun = await clearNativeMutes(novu, { apply: true });
    expect(rerun.mutes).toEqual([]);
    expect(update).not.toHaveBeenCalled();
  });

  it("records a failed write and carries on with the rest", async () => {
    const { novu, update } = fakeNovu(initial);
    update.mockRejectedValueOnce(new Error("Novu 503"));

    const result = await clearNativeMutes(novu, { apply: true });

    expect(result.failures).toEqual([
      { subscriberId: "u1", workflowId: null, error: "Novu 503" },
    ]);
    expect(result.cleared).toBe(2);
  });

  it("reports a family write refused as read-only apart from real failures", async () => {
    const { novu, update } = fakeNovu(initial);
    update.mockImplementation(async (dto: { workflowId?: string }) => {
      if (dto.workflowId) {
        throw new Error("Cannot update preferences of a readOnly workflow");
      }
      return {};
    });

    const result = await clearNativeMutes(novu, { apply: true });

    expect(result.readOnlyRefusals).toEqual([
      { subscriberId: "u1", workflowId: "payment" },
      { subscriberId: "u2", workflowId: "org-billing" },
    ]);
    expect(result.failures).toEqual([]);
    expect(result.cleared).toBe(1);
  });
});
