import { byCodeUnit } from "@/lib/scheduling/code-unit-order";

describe("byCodeUnit", () => {
  it("orders by UTF-16 code unit, never by locale", () => {
    expect(["b", "a", "Z", "B", "é", "e"].sort(byCodeUnit)).toEqual([
      "B",
      "Z",
      "a",
      "b",
      "e",
      "é",
    ]);
  });

  it("keeps equal keys equal, so a signature is stable", () => {
    expect(byCodeUnit("occ-1", "occ-1")).toBe(0);
    expect(["occ-10", "occ-2", "occ-1"].sort(byCodeUnit).join(",")).toBe(
      "occ-1,occ-10,occ-2",
    );
  });
});
