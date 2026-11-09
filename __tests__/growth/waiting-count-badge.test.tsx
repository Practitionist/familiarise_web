import { render, screen } from "@testing-library/react";

import { WaitingCountBadge } from "@/components/booking/WaitingCountBadge";

it("renders nothing when nobody is waiting", () => {
  const { container } = render(<WaitingCountBadge count={0} />);
  expect(container.firstChild).toBeNull();
});

it("shows the count with accessible text", () => {
  render(<WaitingCountBadge count={3} />);
  expect(screen.getByText("3 waiting")).toBeTruthy();
  expect(screen.getByLabelText("3 people waiting for a seat")).toBeTruthy();
});

it("uses the singular for one person", () => {
  render(<WaitingCountBadge count={1} />);
  expect(screen.getByLabelText("1 person waiting for a seat")).toBeTruthy();
});
