import { libraryStatusLabel } from "@/lib/documents/thread-copy";

describe("library status filter labels", () => {
  it("uses the row chips' words for the viewer's side", () => {
    expect(libraryStatusLabel("waiting", "learner")).toBe("Waiting for review");
    expect(libraryStatusLabel("waiting", "expert")).toBe("Waiting for learner");
    expect(libraryStatusLabel("your-turn", "learner")).toBe("Your turn");
    expect(libraryStatusLabel("your-turn", "expert")).toBe("Your turn");
    expect(libraryStatusLabel("waiting", "mixed")).toBe(
      "Waiting for review / Needs revision",
    );
  });
});
