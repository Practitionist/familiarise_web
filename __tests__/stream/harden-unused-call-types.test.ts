/**
 * @jest-environment node
 */

/**
 * #1280 — the three built-in call types this app never uses were permissive
 * enough that a plain `user` could create a call on them and start recording,
 * transcription and broadcasting. Video tokens here are app-wide, so every
 * signed-in user held one that worked on all of them.
 *
 * The catastrophic mistake this file exists to prevent is the strip list ever
 * containing the type the app actually uses. Everyone would lose every call.
 */

import { STREAM_CALL_TYPE } from "../../lib/stream/call-cid";
import {
  BILLABLE_PERMISSIONS,
  END_USER_ROLES,
  HOST_ROLE,
  REACH_PERMISSIONS,
  TRUSTED_ROLES,
  UNUSED_TYPES,
} from "../../scripts/stream/harden-unused-call-types";

describe("harden-unused-call-types", () => {
  it("never targets the call type the app actually uses", () => {
    expect(UNUSED_TYPES as readonly string[]).not.toContain(STREAM_CALL_TYPE);
  });

  it("leaves platform-staff roles alone", () => {
    // Staff hold Stream's `admin` via mapRoleToStream, and an operator has to be
    // able to inspect or end a call on any type. `global_read_only` is read-only.
    for (const role of ["admin", "global_admin", "global_read_only"]) {
      expect(END_USER_ROLES).not.toContain(role);
    }
  });

  it("strips every way of reaching a call, including the -any-team variants", () => {
    // `call_member` on `development` held `join-call-any-team`, which is broader
    // than the plain grant and would survive stripping only `join-call`.
    for (const base of ["create-call", "join-call"]) {
      expect(REACH_PERMISSIONS).toContain(base);
      expect(REACH_PERMISSIONS).toContain(`${base}-any-team`);
    }
  });

  it("strips the billable starters too", () => {
    // Stripped even though reach is already gone, so that re-granting reach
    // later cannot silently re-arm the meter (#1160).
    for (const perm of [
      "start-recording",
      "start-transcription",
      "start-broadcasting",
      "start-frame-recording",
    ]) {
      expect(BILLABLE_PERMISSIONS).toContain(perm);
    }
  });

  it("covers the roles an end user can actually hold", () => {
    for (const role of ["user", "guest", "anonymous", "call_member"]) {
      expect(END_USER_ROLES).toContain(role);
    }
  });
});

describe("host survives hardening", () => {
  /**
   * `host` used to be in END_USER_ROLES. Running this script AFTER
   * `--plan livestream-webinar` therefore stripped the webinar's own presenter of
   * `join-call` and `start-broadcasting`, leaving the type unusable while the
   * script reported success. It cannot be self-assigned — only `updateCallMembers`
   * grants it — so stripping it removes nothing an attacker could hold, and a
   * presenter needs `join-call` to reach the call at all.
   */
  it("does not strip `host`, which the webinar posture grants the starters to", () => {
    expect(END_USER_ROLES).not.toContain(HOST_ROLE);
    expect(TRUSTED_ROLES).toContain(HOST_ROLE);
  });

  /**
   * A role in both lists is a contradiction the script cannot resolve: either the
   * strip loop or the trusted-report counts it, and which one wins is an accident
   * of ordering rather than a decision.
   */
  it("keeps END_USER_ROLES and TRUSTED_ROLES disjoint", () => {
    const overlap = END_USER_ROLES.filter((r) =>
      (TRUSTED_ROLES as readonly string[]).includes(r),
    );
    expect(overlap).toEqual([]);
  });
});
