import {
  GATEWAY_FILTER_OPTIONS,
  gatewaySelect,
  pagedListFilters,
  statusSelect,
} from "@/components/dashboard/shared/paged-list-filters";

function setup(search = "", status = "all") {
  const setSearch = jest.fn();
  const setStatus = jest.fn();
  const setPage = jest.fn();
  const props = pagedListFilters({
    search: {
      label: "Search refunds",
      placeholder: "Search…",
      value: search,
      onChange: setSearch,
    },
    selects: [
      {
        key: "status",
        label: "Status",
        value: status,
        options: [],
        onChange: setStatus,
      },
    ],
    setPage,
  });
  return { props, setSearch, setStatus, setPage };
}

describe("pagedListFilters", () => {
  it("returns to page 1 on a search or select change", () => {
    const { props, setSearch, setStatus, setPage } = setup();
    props.search?.onChange("rf_1");
    props.selects?.[0].onChange("FAILED");
    expect(setSearch).toHaveBeenCalledWith("rf_1");
    expect(setStatus).toHaveBeenCalledWith("FAILED");
    expect(setPage).toHaveBeenCalledTimes(2);
    expect(setPage).toHaveBeenLastCalledWith(1);
  });

  it("offers Clear only when filtered, and Clear resets everything to all", () => {
    expect(setup().props.canClear).toBe(false);
    expect(setup("rf_1").props.canClear).toBe(true);
    const { props, setSearch, setStatus, setPage } = setup("rf_1", "FAILED");
    expect(props.canClear).toBe(true);
    props.onClear?.();
    expect(setSearch).toHaveBeenCalledWith("");
    expect(setStatus).toHaveBeenCalledWith("all");
    expect(setPage).toHaveBeenCalledWith(1);
  });
});

describe("pagedListFilters with an ALL sentinel", () => {
  it("reads and clears back to the list's own no-filter value", () => {
    const setReason = jest.fn();
    const setPage = jest.fn();
    const select = (value: string) =>
      pagedListFilters({
        search: {
          label: "Search",
          placeholder: "",
          value: "",
          onChange: jest.fn(),
        },
        selects: [
          {
            key: "reason",
            label: "Reason",
            value,
            options: [],
            onChange: setReason,
          },
        ],
        setPage,
        allValue: "ALL",
      });
    expect(select("ALL").canClear).toBe(false);
    expect(select("all").canClear).toBe(true);
    select("FOUNDING_EXPERT").onClear?.();
    expect(setReason).toHaveBeenCalledWith("ALL");
    expect(setPage).toHaveBeenCalledWith(1);
  });
});

describe("select builders", () => {
  it("prefix the All option and name the filter", () => {
    const onChange = jest.fn();
    expect(
      statusSelect("all", onChange, [{ value: "WON", label: "Won" }]),
    ).toEqual({
      key: "status",
      label: "Status",
      value: "all",
      onChange,
      options: [
        { value: "all", label: "All Status" },
        { value: "WON", label: "Won" },
      ],
    });
    expect(gatewaySelect("STRIPE", onChange).options).toEqual(
      GATEWAY_FILTER_OPTIONS,
    );
  });
});
