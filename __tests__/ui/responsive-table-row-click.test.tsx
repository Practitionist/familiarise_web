/**
 * @jest-environment jsdom
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import {
  ResponsiveTable,
  type ResponsiveColumn,
} from "@/components/ui/responsive-table";

interface Row {
  id: string;
  label: string;
}

const COLUMNS: ResponsiveColumn<Row>[] = [
  {
    key: "label",
    header: "Label",
    primary: true,
    cell: (row) => row.label,
  },
];

const ROWS: Row[] = [{ id: "row-1", label: "Row one" }];

function renderTable(onRowClick: jest.Mock) {
  render(
    <ResponsiveTable<Row>
      columns={COLUMNS}
      rows={ROWS}
      getRowId={(row) => row.id}
      onRowClick={onRowClick}
    />,
  );
  return screen.getAllByText("Row one")[0];
}

afterEach(cleanup);

it("does not activate a row when the click ends a text selection", () => {
  const onRowClick = jest.fn();
  const cell = renderTable(onRowClick);
  const range = document.createRange();
  range.selectNodeContents(cell);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);

  fireEvent.click(cell);

  expect(onRowClick).not.toHaveBeenCalled();
});

it("activates a row on a plain click", () => {
  const onRowClick = jest.fn();
  const cell = renderTable(onRowClick);
  window.getSelection()?.removeAllRanges();

  fireEvent.click(cell);

  expect(onRowClick).toHaveBeenCalledTimes(1);
});
