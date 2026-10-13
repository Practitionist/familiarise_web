import {
  libraryBucket,
  libraryChip,
  libraryStatusLabel,
} from "@/lib/documents/thread-copy";
import type { ThreadStatus } from "@/lib/documents/thread-view";

const STATUSES: ThreadStatus[] = [
  "WAITING_FOR_EXPERT",
  "IN_REVIEW",
  "NEEDS_REVISION",
  "APPROVED",
  "NOT_ACCEPTED",
];

describe("library status filter and row chips", () => {
  it("labels the filter in the row chips' words for the viewer's side", () => {
    expect(libraryStatusLabel("waiting", "learner")).toBe("Waiting for review");
    expect(libraryStatusLabel("waiting", "expert")).toBe("Waiting for learner");
    expect(libraryStatusLabel("your-turn", "expert")).toBe("Your turn");
    expect(libraryStatusLabel("waiting", "mixed")).toBe(
      "Waiting for review / Waiting for learner",
    );
  });

  it("gives every open row the chip of the filter that returns it", () => {
    for (const side of ["learner", "expert"] as const) {
      for (const status of STATUSES) {
        for (const needsYou of [true, false]) {
          const thread = { shared: false, status, needsYou };
          const bucket = libraryBucket(thread);
          if (bucket !== "your-turn" && bucket !== "waiting") continue;
          expect(libraryChip(thread, side).label).toBe(
            libraryStatusLabel(bucket, side),
          );
        }
      }
    }
  });
});
