/**
 * Enter or Space on a row's "More actions" opens the menu and never the row's
 * detail panel: the trigger and the menu keep those keys to themselves.
 */
import * as React from "react";
import { fireEvent, render, screen } from "@testing-library/react";

import { RowOverflowMenu } from "@/components/appointments/RowOverflowMenu";

function Row({ onOpen }: { onOpen: () => void }) {
  return (
    <div
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") onOpen();
      }}
    >
      <RowOverflowMenu
        items={[{ key: "cancel", label: "Cancel", onClick: jest.fn() }]}
      />
    </div>
  );
}

it.each(["Enter", " "])(
  "%p on the trigger opens the menu, not the row",
  (key) => {
    const onOpen = jest.fn();
    render(<Row onOpen={onOpen} />);
    fireEvent.keyDown(screen.getByRole("button", { name: "More actions" }), {
      key,
    });
    expect(onOpen).not.toHaveBeenCalled();
    expect(
      screen.getByRole("menuitem", { name: "Cancel" }),
    ).toBeInTheDocument();
  },
);

it("Enter on a menu item does not reach the row", () => {
  const onOpen = jest.fn();
  render(<Row onOpen={onOpen} />);
  fireEvent.keyDown(screen.getByRole("button", { name: "More actions" }), {
    key: "Enter",
  });
  fireEvent.keyDown(screen.getByRole("menuitem", { name: "Cancel" }), {
    key: "Enter",
  });
  expect(onOpen).not.toHaveBeenCalled();
});
