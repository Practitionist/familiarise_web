/**
 * @jest-environment node
 */

// RFC 5545 §3.1: every physical .ics line is at most 75 octets, and unfolding restores each value.

import { buildIcs } from "../../lib/appointments/ics";

const title =
  "योग और ध्यान की गहन कक्षा — सुबह का सत्र, सभी स्तरों के लिए खुला 🧘 with a long English tail";

it("folds long lines on character boundaries and unfolds back to the value", () => {
  const ics = buildIcs({
    title,
    description: `Join from your Familiarise dashboard: https://familiarisenow.com/dashboard/go/auto/appointments/${"a".repeat(36)}`,
    sessions: [
      {
        id: "occ-1",
        startsAt: new Date("2026-11-20T04:30:00Z"),
        endsAt: null,
      },
    ],
    zone: "UTC",
  });

  const physical = ics.split("\r\n");
  for (const line of physical) {
    expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(75);
    // A lone surrogate would not survive a UTF-8 round trip.
    expect(Buffer.from(line, "utf8").toString("utf8")).toBe(line);
  }
  expect(physical.some((line) => line.startsWith(" "))).toBe(true);

  const unfolded = ics.replaceAll("\r\n ", "").split("\r\n");
  expect(unfolded).toContain(`SUMMARY:${title.replaceAll(",", "\\,")}`);
  expect(unfolded.find((l) => l.startsWith("DESCRIPTION:"))).toContain(
    "a".repeat(36),
  );
});
