/**
 * @jest-environment node
 */

/**
 * #C9 — the room id is built and PARSED in one place.
 *
 * The builder used to be a template literal buried in `provisionAppointmentMeeting`
 * with no reader anywhere, which is what made a #1607 rebuild destructive to an
 * open tab: the row's `streamCallId` moved to `occurrence-<id>-r<suffix>`, and
 * the `/meetings/occurrence-<id>` URL the person was already sitting on stopped
 * resolving. Nothing could find the room by its old name, including the "Try to
 * Rejoin" button, which re-posts to the URL it arrived on.
 *
 * So the id is round-trippable: anything built by this module parses back to the
 * occurrence it names, in either shape and whatever its vintage.
 */
import {
  occurrenceIdFromRoomId,
  rebuiltRoomIdForOccurrence,
  roomIdForOccurrence,
} from "../../lib/meetings/room-id";

describe("room ids round-trip through their occurrence", () => {
  it("builds the first-minted shape", () => {
    expect(roomIdForOccurrence("clx0abc123")).toBe("occurrence-clx0abc123");
  });

  it("builds a rebuild shape that is distinguishable from the first", () => {
    const rebuilt = rebuiltRoomIdForOccurrence(
      "clx0abc123",
      new Date("2026-09-13T11:20:00.000Z"),
    );
    // A call's `ended_at` never clears, so the rebuild has to name a call that
    // has never existed — hence the suffix rather than a re-use of the old id.
    expect(rebuilt.startsWith("occurrence-clx0abc123-r")).toBe(true);
    expect(rebuilt).not.toBe(roomIdForOccurrence("clx0abc123"));
  });

  it("parses both shapes back to the same occurrence", () => {
    expect(occurrenceIdFromRoomId(roomIdForOccurrence("clx0abc123"))).toBe(
      "clx0abc123",
    );
    expect(
      occurrenceIdFromRoomId(
        rebuiltRoomIdForOccurrence(
          "clx0abc123",
          new Date("2026-09-13T11:20:00.000Z"),
        ),
      ),
    ).toBe("clx0abc123");
  });

  it("answers null for an id that names no occurrence", () => {
    // The join gate's "no such meeting", not a crash on a malformed bookmark.
    expect(occurrenceIdFromRoomId("legacy-uuid")).toBeNull();
    expect(occurrenceIdFromRoomId("")).toBeNull();
    expect(occurrenceIdFromRoomId("occurrence-")).toBeNull();
  });

  it("strips a rebuild suffix from the RIGHT", () => {
    // Cuid ids are alphanumeric today, so `-r…` is unambiguous. Anchoring at the
    // left would quietly eat a dash out of any id format that ever gains one.
    expect(occurrenceIdFromRoomId("occurrence-abc-r1")).toBe("abc");
    expect(occurrenceIdFromRoomId("occurrence-abc-def-r1")).toBe("abc-def");
  });
});
