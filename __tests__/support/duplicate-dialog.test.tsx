import * as React from "react";
import { fireEvent, render, screen } from "@testing-library/react";

jest.mock(
  "../../components/dashboard/backoffice/BackofficeCapabilityProvider",
  () => ({
    useBackofficeCapability: () => ({
      viewerId: "u",
      basePath: "/b",
      can: () => true,
    }),
  }),
);

import {
  DuplicateDialog,
  duplicateMessage,
} from "../../components/dashboard/backoffice/support/CaseWorkspace";

const duplicates = [
  { id: "a", reference: "SR-1", title: "Refund missing" },
  { id: "b", reference: "SR-2", title: "Refund still missing" },
];

it("lets staff pick the target and never claims a merge", () => {
  const onConfirm = jest.fn();
  function Harness() {
    const [target, setTarget] = React.useState<string | null>("a");
    return (
      <DuplicateDialog
        duplicates={duplicates}
        target={target}
        onTargetChange={setTarget}
        busy={false}
        onConfirm={onConfirm}
      />
    );
  }
  render(<Harness />);
  fireEvent.click(screen.getByLabelText(/SR-2/));
  expect(screen.getByRole("alertdialog")).toHaveTextContent(
    "We'll continue in your other support request SR-2",
  );
  expect(duplicateMessage("SR-2")).not.toMatch(/merge/i);
  fireEvent.click(screen.getByRole("button", { name: "Send and close" }));
  expect(onConfirm).toHaveBeenCalledWith("SR-2");
});
