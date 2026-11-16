/** @jest-environment node */
/**
 * The deadline is a decision, not a first look: every surface that states the
 * 72 hours says support decides within them.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SURFACES = [
  "app/(pages)/refund/page.tsx",
  "app/(pages)/terms/page.tsx",
  "app/meetings/[id]/components/AttendeeModeration.tsx",
  "components/events/RemoveParticipantDialog.tsx",
  "app/dashboard/consultant/[consultantId]/(features)/appointments/participants/[eventType]/[eventId]/page.tsx",
  "lib/support/conduct-removal-case.ts",
];

it.each(SURFACES)("%s says support decides within 72 hours", (file) => {
  const text = readFileSync(join(process.cwd(), file), "utf8").replace(
    /\s+/g,
    " ",
  );
  const hours = String.raw`(72|\$\{CONDUCT_REMOVAL_REVIEW_HOURS\})`;
  expect(text).not.toMatch(
    new RegExp(
      String.raw`review(s)? (it|this|the removal)?,? ?within ${hours}`,
    ),
  );
  expect(text).toMatch(
    new RegExp(String.raw`decide(s)?( it)? within ${hours} hours`),
  );
});

it("says the block covers every open room of the event, not one call", () => {
  const dialog = readFileSync(
    join(process.cwd(), "components/events/RemoveParticipantDialog.tsx"),
    "utf8",
  ).replace(/\s+/g, " ");
  expect(dialog).not.toContain("this session&apos;s call");
  expect(dialog).toContain("blocked from this event&apos;s calls");
});
