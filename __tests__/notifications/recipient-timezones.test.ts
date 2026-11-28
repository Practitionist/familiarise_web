const globalFindMany = jest.fn();
jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  default: {
    user: { findMany: (...args: unknown[]) => globalFindMany(...args) },
  },
}));

import prisma, { type Db } from "@/lib/prisma";
import {
  DEFAULT_NOTIFICATION_TIMEZONE,
  resolveRecipientTimezones,
} from "@/lib/novu/humanize";

const ROW = { id: "u1", timezone: "America/New_York" };

function txWith(findMany: jest.Mock): Pick<Db, "user"> {
  return { user: { findMany } } as unknown as Pick<Db, "user">;
}

function after<T>(ms: number, value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

describe("resolveRecipientTimezones", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    globalFindMany.mockReset();
  });
  afterEach(() => jest.useRealTimers());

  it("rethrows a failed read on a transaction client", async () => {
    const conflict = Object.assign(new Error("serialization failure"), {
      code: "P2034",
    });
    const tx = txWith(jest.fn().mockRejectedValue(conflict));
    await expect(resolveRecipientTimezones(["u1"], tx)).rejects.toBe(conflict);
  });

  it("awaits a slow read on a transaction client instead of returning defaults", async () => {
    const tx = txWith(jest.fn(() => after(5_000, [ROW])));
    const pending = resolveRecipientTimezones(["u1"], tx);
    await jest.advanceTimersByTimeAsync(5_000);
    expect((await pending).get("u1")).toBe("America/New_York");
  });

  it("falls back to the default zone when the global read fails", async () => {
    globalFindMany.mockRejectedValue(new Error("pool exhausted"));
    const zones = await resolveRecipientTimezones(["u1"], prisma);
    expect(zones.get("u1")).toBe(DEFAULT_NOTIFICATION_TIMEZONE);
  });

  it("falls back to the default zone when the global read outlasts the timeout", async () => {
    globalFindMany.mockImplementation(() => after(5_000, [ROW]));
    const pending = resolveRecipientTimezones(["u1"]);
    await jest.advanceTimersByTimeAsync(2_000);
    expect((await pending).get("u1")).toBe(DEFAULT_NOTIFICATION_TIMEZONE);
  });
});
