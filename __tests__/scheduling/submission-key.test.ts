/**
 * @jest-environment node
 */

import { createSubmissionKeys } from "@/lib/api/submission-key";

describe("createSubmissionKeys", () => {
  it("reuses the key for a repeat of the same submission and mints a new one when it changes", () => {
    const keyFor = createSubmissionKeys();
    const first = keyFor({ slotIds: ["a"], proposedSlots: undefined });
    expect(keyFor({ slotIds: ["a"], proposedSlots: undefined })).toBe(first);
    const changed = keyFor({ slotIds: ["a", "b"] });
    expect(changed).not.toBe(first);
    // Going back to the first payload is a new submission, not a replay.
    expect(keyFor({ slotIds: ["a"], proposedSlots: undefined })).not.toBe(
      first,
    );
    // Long enough for the server's 10-character minimum.
    expect(first.length).toBeGreaterThanOrEqual(10);
  });

  it("keeps separate keys per button", () => {
    const a = createSubmissionKeys();
    const b = createSubmissionKeys();
    expect(a({})).not.toBe(b({}));
  });
});
