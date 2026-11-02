/**
 * Pinned chats lead the list without disturbing the newest-activity order, and
 * a row's time reads like a messenger's rather than "25 days".
 */
import type { Channel } from "stream-chat";

import {
  channelPinnedAt,
  formatRowTime,
  pinnedFirst,
} from "../../components/chat/utils/channelUtils";

const ch = (cid: string, pinnedAt?: string | null) =>
  ({
    cid,
    state: {
      membership: pinnedAt === undefined ? {} : { pinned_at: pinnedAt },
    },
  }) as unknown as Channel;

describe("pinnedFirst", () => {
  const a = ch("a");
  const b = ch("b", "2026-10-01T00:00:00Z");
  const c = ch("c");
  const d = ch("d", "2026-10-20T00:00:00Z");

  it("puts pinned first, latest pin on top, and keeps the rest in order", () => {
    expect(pinnedFirst([a, b, c, d])).toEqual([d, b, a, c]);
  });

  it("returns the same list when nothing is pinned", () => {
    const list = [a, c];
    expect(pinnedFirst(list)).toBe(list);
  });

  it("applies a pin changed since the list loaded", () => {
    expect(pinnedFirst([a, c], { c: "2026-10-30T00:00:00Z" })).toEqual([c, a]);
  });

  it("applies an unpin changed since the list loaded", () => {
    expect(pinnedFirst([a, b], { b: null })).toEqual([a, b]);
    expect(channelPinnedAt(b, { b: null })).toBeNull();
  });
});

describe("formatRowTime", () => {
  // Thu 30 Oct 2026, 15:30 local.
  const now = new Date(2026, 9, 30, 15, 30);
  const at = (y: number, m: number, d: number, h = 9, min = 5) =>
    new Date(y, m - 1, d, h, min);

  it("shows the clock time for today", () => {
    expect(formatRowTime(at(2026, 10, 30, 9, 5), now)).toBe("9:05 AM");
    expect(formatRowTime(at(2026, 10, 30, 0, 1), now)).toBe("12:01 AM");
  });

  it("says Yesterday across midnight, even a few minutes apart", () => {
    expect(formatRowTime(at(2026, 10, 29, 23, 59), now)).toBe("Yesterday");
  });

  it("shows the weekday within the last week", () => {
    expect(formatRowTime(at(2026, 10, 27), now)).toBe("Tue");
    expect(formatRowTime(at(2026, 10, 24), now)).toBe("Sat");
  });

  it("shows the date from a week ago, with the year only when it differs", () => {
    expect(formatRowTime(at(2026, 10, 23), now)).toBe("23 Oct");
    expect(formatRowTime(at(2026, 10, 6), now)).toBe("6 Oct");
    expect(formatRowTime(at(2025, 12, 31), now)).toBe("31 Dec 2025");
  });

  it("treats a timestamp slightly ahead of this device's clock as today", () => {
    expect(formatRowTime(new Date(2026, 9, 30, 15, 31), now)).toBe("3:31 PM");
  });

  it("accepts an ISO string", () => {
    expect(formatRowTime(at(2026, 10, 30, 9, 5).toISOString(), now)).toBe(
      "9:05 AM",
    );
  });
});
