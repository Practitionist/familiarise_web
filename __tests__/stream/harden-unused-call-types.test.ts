/**
 * @jest-environment node
 */

import { STREAM_CALL_TYPE } from "../../lib/stream/call-cid";
import {
  UNUSED_TYPES,
  END_USER_ROLES,
  REACH_PERMISSIONS,
  BILLABLE_PERMISSIONS,
  matchesPermissionWithScope,
} from "../../scripts/stream/harden-unused-call-types";

describe("harden-unused-call-types", () => {
  it("never targets the call type the app actually uses", () => {
    expect(UNUSED_TYPES as readonly string[]).not.toContain(STREAM_CALL_TYPE);
  });

  it("leaves platform-staff roles alone", () => {
    for (const role of ["admin", "global_admin", "global_read_only"]) {
      expect(END_USER_ROLES).not.toContain(role);
    }
  });

  it("strips every way of reaching a call, including the -any-team variants", () => {
    for (const base of [
      "create-call",
      "join-call",
      "join-backstage",
      "join-ended-call",
    ]) {
      expect(REACH_PERMISSIONS).toContain(base);
      expect(REACH_PERMISSIONS).toContain(`${base}-any-team`);
    }
  });

  it("strips all 19 billable permissions", () => {
    const expectedBillable = [
      "start-recording",
      "stop-recording",
      "start-frame-recording",
      "stop-frame-recording",
      "start-raw-recording",
      "stop-raw-recording",
      "start-individual-recording",
      "stop-individual-recording",
      "start-transcription",
      "stop-transcription",
      "start-closed-captions",
      "stop-closed-captions",
      "start-broadcasting",
      "stop-broadcasting",
      "start-rtmp-broadcasts",
      "stop-rtmp-broadcast",
      "stop-all-rtmp-broadcasts",
      "use-noise-cancellation",
      "enable-noise-cancellation",
    ];
    expect(BILLABLE_PERMISSIONS).toHaveLength(19);
    for (const perm of expectedBillable) {
      expect(BILLABLE_PERMISSIONS).toContain(perm);
    }
  });

  it("matches -owner and -any-team suffix variants via matchesPermissionWithScope", () => {
    expect(
      matchesPermissionWithScope("start-recording", BILLABLE_PERMISSIONS),
    ).toBe(true);
    expect(
      matchesPermissionWithScope("start-recording-owner", BILLABLE_PERMISSIONS),
    ).toBe(true);
    expect(
      matchesPermissionWithScope(
        "start-rtmp-broadcasts-any-team",
        BILLABLE_PERMISSIONS,
      ),
    ).toBe(true);
    expect(
      matchesPermissionWithScope(
        "enable-noise-cancellation-any-team",
        BILLABLE_PERMISSIONS,
      ),
    ).toBe(true);
    expect(matchesPermissionWithScope("send-audio", BILLABLE_PERMISSIONS)).toBe(
      false,
    );
  });

  it("covers the roles an end user can actually hold", () => {
    for (const role of ["user", "guest", "anonymous", "call_member"]) {
      expect(END_USER_ROLES).toContain(role);
    }
  });
});
