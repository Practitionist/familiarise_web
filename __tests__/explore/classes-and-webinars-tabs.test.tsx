/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

jest.mock("@/app/explore/programs/components/ProgramRow", () => ({
  __esModule: true,
  default: ({ programs }: { programs: { title: string }[] }) => (
    <ul>
      {programs.map((p) => (
        <li key={p.title}>{p.title}</li>
      ))}
    </ul>
  ),
}));

import { ClassesAndWebinars } from "@/app/explore/experts/[consultantId]/components/ClassesAndWebinars";

const plan = (id: string, title: string) =>
  ({ id, title, description: "", imageUrl: null, price: 1000 }) as never;

const renderBoth = () =>
  render(
    <ClassesAndWebinars
      classPlans={[plan("c1", "A class")]}
      webinarPlans={[plan("w1", "A webinar")]}
    />,
  );

describe("ClassesAndWebinars tabs", () => {
  it("is a tablist whose tabs name and control their panels", () => {
    renderBoth();
    expect(
      screen.getByRole("tablist", { name: "Program type" }),
    ).toBeInTheDocument();

    const classes = screen.getByRole("tab", { name: /classes/i });
    const webinars = screen.getByRole("tab", { name: /webinars/i });
    expect(classes).toHaveAttribute("aria-selected", "true");
    expect(webinars).toHaveAttribute("aria-selected", "false");

    const panel = screen.getByRole("tabpanel");
    expect(panel).toHaveAttribute("id", classes.getAttribute("aria-controls"));
    expect(panel).toHaveAttribute("aria-labelledby", classes.id);
  });

  it("keeps only the selected tab in the tab order", () => {
    renderBoth();
    expect(screen.getByRole("tab", { name: /classes/i })).toHaveAttribute(
      "tabindex",
      "0",
    );
    expect(screen.getByRole("tab", { name: /webinars/i })).toHaveAttribute(
      "tabindex",
      "-1",
    );
  });

  it("moves with the arrow keys, wrapping, and focuses the tab it lands on", async () => {
    renderBoth();
    const classes = screen.getByRole("tab", { name: /classes/i });
    const webinars = screen.getByRole("tab", { name: /webinars/i });

    fireEvent.keyDown(classes, { key: "ArrowRight" });
    expect(webinars).toHaveAttribute("aria-selected", "true");
    expect(webinars).toHaveFocus();
    await waitFor(() =>
      expect(screen.getByRole("tabpanel")).toHaveAttribute(
        "aria-labelledby",
        webinars.id,
      ),
    );

    fireEvent.keyDown(webinars, { key: "ArrowRight" });
    expect(classes).toHaveAttribute("aria-selected", "true");
    expect(classes).toHaveFocus();

    fireEvent.keyDown(classes, { key: "End" });
    expect(webinars).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(webinars, { key: "Home" });
    expect(classes).toHaveAttribute("aria-selected", "true");
  });

  it("has no tabs, and a count subtitle instead, when there is one kind", () => {
    render(
      <ClassesAndWebinars
        classPlans={[plan("c1", "A class"), plan("c2", "Another class")]}
        webinarPlans={[]}
      />,
    );
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.queryByRole("tabpanel")).toBeNull();
    expect(screen.getByText("2 classes")).toBeInTheDocument();
  });

  it("singularises the subtitle for one webinar", () => {
    render(
      <ClassesAndWebinars classPlans={[]} webinarPlans={[plan("w1", "W")]} />,
    );
    expect(screen.getByText("1 webinar")).toBeInTheDocument();
  });
});
