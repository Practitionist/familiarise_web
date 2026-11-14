// Invariant: a list renders a booking whose open move has lapsed as its
// original session, with no proposal; it writes nothing.

import { withLapsedMoveRestored } from "@/lib/appointments/lapsed-move";

const NOW = new Date("2030-05-01T10:15:00.000Z");
const released = {
  id: "occ-1",
  isTentative: true,
  completionStatus: "RESCHEDULED",
  deletedAt: null,
};

it("shows the original session once the move's deadline has passed", () => {
  const view = withLapsedMoveRestored(
    {
      rescheduleRequests: [{ expiresAt: "2030-05-01T10:15:00.000Z" }],
      occurrences: [released],
    },
    NOW,
  );
  expect(view.rescheduleRequests).toEqual([]);
  expect(view.occurrences?.[0]).toMatchObject({
    completionStatus: "SCHEDULED",
    isTentative: false,
  });
});

it("leaves an open move alone before its deadline", () => {
  const row = {
    rescheduleRequests: [{ expiresAt: "2030-05-01T10:16:00.000Z" }],
    occurrences: [released],
  };
  expect(withLapsedMoveRestored(row, NOW)).toBe(row);
});
