/**
 * @jest-environment node
 */
import { readSidecarMigrationSql } from "../../scripts/db/sidecar-objects";

import {
  END_REASON_POLICY,
  MEETING_END_REASONS,
  endAllowsHostReopen,
  endBlocksRejoin,
  endReasonPolicy,
  mapStreamCallEndedReason,
  meetingEndReasonSchema,
} from "../../lib/meetings/end-reasons";

describe("Meeting end-reason vocabulary", () => {
  it("maps a call.ended webhook onto the vocabulary and never persists Stream's raw reason", () => {
    const map = (
      args: Partial<Parameters<typeof mapStreamCallEndedReason>[0]>,
    ) =>
      mapStreamCallEndedReason({
        endedBeforeStart: false,
        endedByUserId: null,
        ...args,
      });

    expect(map({ endedBeforeStart: true, endedByUserId: "host" })).toBe(
      "ended_early",
    );
    expect(map({ endedByUserId: "host", streamReason: "anything" })).toBe(
      "call_ended",
    );
    expect(map({})).toBe("call_ended");
    expect(map({ streamReason: "end_call" })).toBe("call_ended");
    expect(map({ streamReason: "session_inactivity_timeout" })).toBe(
      "stream_ended",
    );
    expect(
      meetingEndReasonSchema.safeParse("session_inactivity_timeout").success,
    ).toBe(false);
  });

  it("keeps the deliberate, rejoin and money columns consistent", () => {
    const rows = MEETING_END_REASONS.map((r) => END_REASON_POLICY[r]);
    // A deliberate close never lets a participant straight back in.
    expect(rows.filter((r) => r.deliberate && r.rejoinable)).toEqual([]);
    // A rejoinable end needs no host reopen, so the room is never stuck.
    expect(rows.filter((r) => r.rejoinable && r.hostReopenable)).toEqual([]);
    expect(END_REASON_POLICY.call_ended.money).toBe("host_end");
    expect(END_REASON_POLICY.maintenance.money).toBe("outage");
    expect(
      MEETING_END_REASONS.filter(
        (r) => END_REASON_POLICY[r].money !== "none",
      ).sort(),
    ).toEqual(["call_ended", "maintenance"]);

    const ended = new Date();
    expect(
      endBlocksRejoin({ endedAt: ended, endedReason: "stream_ended" }),
    ).toBe(true);
    expect(
      endAllowsHostReopen({ endedAt: ended, endedReason: "stream_ended" }),
    ).toBe(true);
    expect(
      endBlocksRejoin({ endedAt: ended, endedReason: "session_timeout" }),
    ).toBe(false);
    expect(
      endAllowsHostReopen({ endedAt: ended, endedReason: "org_deactivated" }),
    ).toBe(false);
    expect(endReasonPolicy(null).deliberate).toBe(true);
  });

  it("admits exactly the vocabulary in the sidecar CHECK", () => {
    const sql = readSidecarMigrationSql();
    const block = sql.slice(sql.indexOf('"meeting_ended_reason_known"'));
    const inList = block.slice(block.indexOf("IN ("), block.indexOf(")"));
    const admitted = [...inList.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(admitted.sort()).toEqual([...MEETING_END_REASONS].sort());
  });
});
