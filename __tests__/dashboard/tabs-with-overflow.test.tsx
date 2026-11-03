import { act, fireEvent, render, screen, within } from "@testing-library/react";

import { TabsWithOverflow } from "../../components/dashboard/shared/TabsWithOverflow";

let mockTab: string | null = null;
jest.mock("next/navigation", () => ({
  usePathname: () => "/billing",
  useSearchParams: () => new URLSearchParams(mockTab ? `tab=${mockTab}` : ""),
}));
jest.mock("../../lib/navigation/history", () => ({ replaceUrl: jest.fn() }));

const TABS = ["Invoices", "Wallet", "Purchase orders", "Disputes", "Spend"].map(
  (label) => ({
    value: label.toLowerCase().replace(" ", "-"),
    label,
    content: <p>{label} panel</p>,
  }),
);

function expectOneSelected(name: string) {
  const selected = within(screen.getByRole("tablist")).getAllByRole("tab", {
    selected: true,
  });
  expect(selected.map((t) => t.textContent)).toEqual([name]);
  expect(screen.getByRole("tabpanel", { name }).textContent).toBe(
    `${name} panel`,
  );
}

it("an overflow tab opened by URL is a real, selected tab labelling its panel", () => {
  mockTab = "disputes";
  render(<TabsWithOverflow tabs={TABS} />);
  expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual([
    "Invoices",
    "Wallet",
    "Disputes",
  ]);
  expectOneSelected("Disputes");
});

it("choosing a tab from More promotes it into the tablist", async () => {
  mockTab = null;
  render(<TabsWithOverflow tabs={TABS} />);
  expectOneSelected("Invoices");
  const more = screen.getByRole("button", { name: "More" });
  await act(async () => {
    fireEvent.keyDown(more, { key: "Enter" });
  });
  await act(async () => {
    fireEvent.click(await screen.findByRole("menuitem", { name: "Spend" }));
  });
  expectOneSelected("Spend");
  expect(screen.getAllByRole("tab")).toHaveLength(3);
});
