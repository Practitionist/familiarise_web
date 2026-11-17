/**
 * @jest-environment jsdom
 */

/**
 * A phone card keeps its values on screen: the label column is capped so a
 * long label cannot starve the value column, which may shrink and wrap. The
 * decision queue's times wrap below the table breakpoint. Pixel fit is
 * browser-only; these pin the classes that give it.
 */

import { readFileSync } from "fs";
import { join } from "path";
import { render } from "@testing-library/react";

import { ResponsiveTable } from "@/components/ui/responsive-table";

it("caps the card's label column and lets the value column shrink and wrap", () => {
  render(
    <ResponsiveTable<{ id: string }>
      columns={[
        { key: "a", header: "Name", primary: true, cell: (r) => r.id },
        { key: "b", header: "Outcome · minutes lost", cell: () => "x" },
      ]}
      rows={[{ id: "row-1" }]}
      getRowId={(r) => r.id}
    />,
  );
  const dl = document.querySelector("dl");
  expect(dl?.className).toContain("grid-cols-[auto_minmax(0,1fr)]");
  const dt = document.querySelector("dt");
  expect(dt?.className).toContain("max-w-[9rem]");
  const dd = document.querySelector("dd");
  expect(dd?.className).toContain("min-w-0");
});

it("the decision queue lets its times wrap on a phone and keeps one line in the table", () => {
  const src = readFileSync(
    join(
      process.cwd(),
      "components/dashboard/backoffice/money/SessionOutcomesCard.tsx",
    ),
    "utf8",
  );
  expect(src).toContain('const NOWRAP = "md:whitespace-nowrap"');
  expect(src).not.toMatch(/["`]whitespace-nowrap/);
});
