/**
 * @jest-environment node
 */

/** The seat trail the learner and the organiser both read: days in the reader's zone, labelled, and compact. */
import { seatTrailText } from "@/lib/booking/seat-trail-copy";
import type { SeatTrailStep } from "@/lib/booking/seat-history";

const at = (iso: string) => `${iso}:00.000Z`;
const RIYA: SeatTrailStep[] = [
  { reason: "registered", at: at("2026-11-12T03:00") },
  { reason: "self_leave", at: at("2026-11-12T09:00") },
  { reason: "rejoined", at: at("2026-11-13T09:00") },
];

it("reads each day in the reader's zone and names the zone", () => {
  expect(seatTrailText(RIYA, "Asia/Kolkata")).toEqual({
    line: "Left 12 Nov · rejoined 13 Nov (IST)",
    full: "Left 12 Nov · rejoined 13 Nov (IST)",
  });
  // 18:30Z is the next day in Kuching.
  const late = [{ reason: "self_leave", at: at("2026-11-18T18:30") }] as const;
  expect(seatTrailText(late, "Asia/Kuching").line).toBe("Left 19 Nov (GMT+8)");
  expect(seatTrailText(late, "Asia/Kolkata").line).toBe("Left 19 Nov (IST)");
});

it("shows the last three steps of a long trail and counts the earlier ones", () => {
  const long: SeatTrailStep[] = [
    { reason: "registered", at: at("2026-11-18T03:00") },
    { reason: "self_leave", at: at("2026-11-18T04:00") },
    { reason: "rejoined", at: at("2026-11-18T05:00") },
    { reason: "organiser_removal", at: at("2026-11-18T06:00") },
    { reason: "block_lifted", at: at("2026-11-18T07:00") },
    { reason: "rejoined", at: at("2026-11-18T08:00") },
    { reason: "self_leave", at: at("2026-11-19T04:00") },
  ];
  const text = seatTrailText(long, "Asia/Kolkata");
  expect(text.line).toBe(
    "3 earlier changes, then allowed back 18 Nov · rejoined 18 Nov · left 19 Nov (IST)",
  );
  expect(text.full).toBe(
    "Left 18 Nov · rejoined 18 Nov · removed by the organiser 18 Nov · allowed back 18 Nov · rejoined 18 Nov · left 19 Nov (IST)",
  );
});

it("is empty for a seat that only registered", () => {
  expect(seatTrailText(RIYA.slice(0, 1), "Asia/Kolkata")).toEqual({
    line: "",
    full: "",
  });
});
