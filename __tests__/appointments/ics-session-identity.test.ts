/**
 * @jest-environment node
 */

// One calendar entry per session across a move or a cancel: a stable UID from
// the booking and the session's ordinal, a SEQUENCE that rises with each change
// (RFC 5545 §3.8.7.4), and a cancelled session as STATUS:CANCELLED (RFC 5546).

import {
  buildIcs,
  icsSessionId,
  icsSessions,
} from "../../lib/appointments/ics";

const at = (iso: string) => new Date(iso);
const occurrence = (over: {
  ordinal: number;
  startsAt: string;
  updatedAt: string;
  cancelled?: boolean;
}) => ({
  ordinal: over.ordinal,
  startsAt: at(over.startsAt),
  endsAt: null,
  updatedAt: at(over.updatedAt),
  cancelled: over.cancelled ?? false,
});
const lines = (ics: string) => ics.replaceAll("\r\n ", "").split("\r\n");
const render = (sessions: ReturnType<typeof icsSessions>) =>
  lines(buildIcs({ title: "Deep work", sessions, zone: "UTC" }));

it("a moved session keeps its UID and raises its SEQUENCE, so a re-import replaces the entry", () => {
  // The move deletes the Thursday row and writes a Friday row with the same ordinal.
  const before = render(
    icsSessions("appt-1", [
      occurrence({
        ordinal: 2,
        startsAt: "2026-11-26T12:30:00Z",
        updatedAt: "2026-11-23T04:30:00Z",
      }),
    ]),
  );
  const after = render(
    icsSessions("appt-1", [
      occurrence({
        ordinal: 2,
        startsAt: "2026-11-27T05:30:00Z",
        updatedAt: "2026-11-24T04:30:00Z",
      }),
    ]),
  );

  const uid = `UID:${icsSessionId("appt-1", 2)}@familiarise`;
  expect(before).toContain(uid);
  expect(after).toContain(uid);
  const sequence = (file: string[]) =>
    Number(file.find((l) => l.startsWith("SEQUENCE:"))?.slice(9));
  expect(sequence(after)).toBeGreaterThan(sequence(before));
  expect(after).toContain("DTSTART:20261127T053000Z");
  expect(after).toContain("METHOD:PUBLISH");
  expect(after).toContain("STATUS:CONFIRMED");
});

it("two sessions of one booking, and the same ordinal on another booking, are different entries", () => {
  expect(icsSessionId("appt-1", 1)).not.toBe(icsSessionId("appt-1", 2));
  expect(icsSessionId("appt-1", 1)).not.toBe(icsSessionId("appt-2", 1));
});

it("a cancelled session downloads as a cancellation of the same entry", () => {
  const file = render(
    icsSessions("appt-1", [
      occurrence({
        ordinal: 2,
        startsAt: "2026-11-26T12:30:00Z",
        updatedAt: "2026-11-25T04:30:00Z",
        cancelled: true,
      }),
    ]),
  );

  expect(file).toContain("METHOD:CANCEL");
  expect(file).toContain(`UID:${icsSessionId("appt-1", 2)}@familiarise`);
  expect(file).toContain("STATUS:CANCELLED");
  expect(file).not.toContain("STATUS:CONFIRMED");
});

it("a booking with one cancelled session and others still on publishes all of them, the cancelled one marked", () => {
  const file = render(
    icsSessions("appt-1", [
      occurrence({
        ordinal: 1,
        startsAt: "2026-11-26T12:30:00Z",
        updatedAt: "2026-11-25T04:30:00Z",
        cancelled: true,
      }),
      occurrence({
        ordinal: 2,
        startsAt: "2026-12-03T12:30:00Z",
        updatedAt: "2026-11-20T04:30:00Z",
      }),
    ]),
  );

  expect(file).toContain("METHOD:PUBLISH");
  expect(file.filter((l) => l === "STATUS:CANCELLED")).toHaveLength(1);
  expect(file.filter((l) => l === "STATUS:CONFIRMED")).toHaveLength(1);
});

it("one entry per session: a live row wins over a cancelled row of the same ordinal", () => {
  const sessions = icsSessions("appt-1", [
    occurrence({
      ordinal: 3,
      startsAt: "2026-11-26T12:30:00Z",
      updatedAt: "2026-11-25T04:30:00Z",
      cancelled: true,
    }),
    occurrence({
      ordinal: 3,
      startsAt: "2026-11-28T12:30:00Z",
      updatedAt: "2026-11-24T04:30:00Z",
    }),
  ]);

  expect(sessions).toHaveLength(1);
  expect(sessions[0]).toMatchObject({
    id: icsSessionId("appt-1", 3),
    cancelled: false,
    startsAt: at("2026-11-28T12:30:00Z"),
  });
  // Its SEQUENCE is the latest change to the session, so it still outranks the cancelled copy.
  expect(sessions[0].sequence).toBe(
    Math.floor(at("2026-11-25T04:30:00Z").getTime() / 1000),
  );
});
