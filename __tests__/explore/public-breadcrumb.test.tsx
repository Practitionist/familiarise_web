/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react";

import { PlanBreadcrumb } from "@/components/explore/PublicBreadcrumb";

const plan = {
  title: "Advanced Class",
  consultantProfile: { id: "e1", user: { name: "Aarav Anderson" } },
};

describe("PlanBreadcrumb", () => {
  it("keeps the Experts root visible on phones, the only direct route to the list", () => {
    render(<PlanBreadcrumb plan={plan} />);
    const root = screen.getByRole("link", { name: "Experts" });
    expect(root).toHaveAttribute("href", "/explore/experts");
    // jsdom has no layout: assert the class that hid it below `sm` is gone.
    expect(root.closest("li")?.className).not.toMatch(/\bhidden\b/);
  });

  it("links the expert and marks the plan as the current page", () => {
    render(<PlanBreadcrumb plan={plan} />);
    expect(
      screen.getByRole("link", { name: "Aarav Anderson" }),
    ).toHaveAttribute("href", "/explore/experts/e1");
    expect(screen.getByText("Advanced Class").closest("li")).toHaveAttribute(
      "aria-current",
      "page",
    );
  });
});
