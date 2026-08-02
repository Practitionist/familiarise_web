import {
  orgFiltersFromSearchParams,
  orgFiltersToSearchParams,
} from "@/lib/explore/organisation-filters";

describe("orgFiltersFromSearchParams", () => {
  it("hydrates Expert networks nav links (?type=EXPERT_NETWORK)", () => {
    const params = new URLSearchParams("type=EXPERT_NETWORK");
    const filters = orgFiltersFromSearchParams(params);
    expect(filters.types).toEqual(["EXPERT_NETWORK"]);
    expect(orgFiltersToSearchParams(filters)).toBe("type=EXPERT_NETWORK");
  });

  it("accepts repeated type params", () => {
    const params = new URLSearchParams();
    params.append("type", "EXPERT_NETWORK");
    params.append("type", "LEARNING_INSTITUTION");
    const filters = orgFiltersFromSearchParams(params);
    expect(filters.types).toEqual([
      "EXPERT_NETWORK",
      "LEARNING_INSTITUTION",
    ]);
  });

  it("ignores unknown type values", () => {
    const params = new URLSearchParams("type=NOT_A_REAL_TYPE");
    expect(orgFiltersFromSearchParams(params).types).toEqual([]);
  });
});
