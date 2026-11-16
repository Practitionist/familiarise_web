import { fireEvent, render, screen } from "@testing-library/react";

import { FilterMenu } from "@/components/dashboard/FilterMenu";

const options = [
  { value: "answer-today", label: "Answer today" },
  { value: "declined", label: "Declined" },
];

describe("FilterMenu optional props", () => {
  it("reports option intent with the value a click would pick", () => {
    const onOptionIntent = jest.fn();
    render(
      <FilterMenu
        label="Show"
        options={options}
        value="declined"
        onChange={jest.fn()}
        onOptionIntent={onOptionIntent}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Show: Declined" }));

    fireEvent.pointerEnter(
      screen.getByRole("button", { name: /Answer today/ }),
    );
    expect(onOptionIntent).toHaveBeenLastCalledWith("answer-today");
    // Re-picking the active option clears it, so its intent is the unfiltered list.
    fireEvent.focus(screen.getByRole("button", { name: /^Declined/ }));
    expect(onOptionIntent).toHaveBeenLastCalledWith(null);
    fireEvent.pointerEnter(screen.getByRole("button", { name: /^All/ }));
    expect(onOptionIntent).toHaveBeenLastCalledWith(null);
  });

  it("disables the trigger and the clear button", () => {
    const onChange = jest.fn();
    render(
      <FilterMenu
        label="Show"
        options={options}
        value="declined"
        onChange={onChange}
        disabled
      />,
    );
    expect(
      screen.getByRole("button", { name: "Show: Declined" }),
    ).toBeDisabled();
    const clear = screen.getByRole("button", { name: "Clear show filter" });
    expect(clear).toBeDisabled();
    fireEvent.click(clear);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("stays enabled by default", () => {
    render(
      <FilterMenu
        label="Show"
        options={options}
        value={null}
        onChange={jest.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Show: All" })).toBeEnabled();
  });
});
