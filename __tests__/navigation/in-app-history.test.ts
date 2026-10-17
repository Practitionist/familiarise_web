import { nextHistoryStack } from "../../lib/navigation/in-app-history";

describe("nextHistoryStack", () => {
  it("pushes a new pathname", () => {
    expect(nextHistoryStack(["/a"], "/b")).toEqual(["/a", "/b"]);
  });

  it("is a no-op when the pathname equals the top", () => {
    expect(nextHistoryStack(["/a", "/b"], "/b")).toEqual(["/a", "/b"]);
  });

  it("pops when returning to the previous entry", () => {
    expect(nextHistoryStack(["/a", "/b"], "/a")).toEqual(["/a"]);
  });

  it("starts a trail from empty", () => {
    expect(nextHistoryStack([], "/a")).toEqual(["/a"]);
  });

  it("caps the trail length", () => {
    const long = Array.from({ length: 50 }, (_, i) => `/p${i}`);
    const next = nextHistoryStack(long, "/new");
    expect(next).toHaveLength(50);
    expect(next.at(-1)).toBe("/new");
    expect(next[0]).toBe("/p1");
  });
});
