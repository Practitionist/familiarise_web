/**
 * PersonCell: the full name and email on hover (phone cards truncate them), a
 * "(you)" suffix, and an anonymous reviewer named to staff with the label the
 * public sees instead of their name.
 */

import { render, screen } from "@testing-library/react";

import { PersonCell } from "@/components/dashboard/backoffice/PersonCell";
import { formatPerson, REMOVED_USER } from "@/lib/backoffice/person";

const priya = {
  id: "u-1",
  name: "Priya Anderson",
  email: "priya.anderson@example.test",
};

it("carries the full name and email in its title", () => {
  const { container } = render(<PersonCell person={priya} suffix="(you)" />);
  expect(container.firstElementChild?.getAttribute("title")).toBe(
    "Priya Anderson · priya.anderson@example.test",
  );
  expect(screen.getByText("(you)")).toBeTruthy();
});

it("names an anonymous reviewer to staff, labelled as anonymous to the public", () => {
  render(
    <PersonCell
      person={{ id: "ce-1", name: "Priya Anderson" }}
      anonymousLabel="Anonymous to the public"
    />,
  );
  expect(screen.getByText("Priya Anderson")).toBeTruthy();
  expect(screen.getByText("Anonymous to the public")).toBeTruthy();
});

it("reads the anonymous label, not 'Removed user', when no name is known", () => {
  expect(
    formatPerson({ id: "ce-1" }, { anonymousLabel: "Anonymous" }),
  ).toMatchObject({ primary: "Anonymous", anonymous: null });
  expect(formatPerson({ id: "ce-1" }).primary).toBe(REMOVED_USER);
});
